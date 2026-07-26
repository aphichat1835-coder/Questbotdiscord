import { createHash } from 'node:crypto';
import { chooseNextQuestAction } from './smart-scheduler.js';
import { publishScheduleHint } from './schedule-hint-bus.js';

const MAX_RESET_DELAY_MS = 60_000;
const DEFAULT_MAX_CONCURRENCY = 4;

function headerNumber(headers, name) {
  const value = Number.parseFloat(headers?.get?.(name));
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function authorizationFingerprint(value = '') {
  const authorization = typeof value === 'string'
    ? value
    : new Headers(value).get('authorization') ?? 'anonymous';
  return createHash('sha256').update(authorization).digest('hex').slice(0, 16);
}

function routeKey(url, method) {
  const parsed = new URL(url);
  const normalized = parsed.pathname
    .replace(/^\/api\/v\d+/, '')
    .replace(/\/quests\/[^/]+/g, '/quests/:questId')
    .replace(/\/channels\/\d+/g, '/channels/:channelId')
    .replace(/\/guilds\/\d+/g, '/guilds/:guildId');
  return `${method}:${normalized}`;
}

function requestPriority(url, method) {
  const path = new URL(url).pathname;
  if (/\/claim(?:-reward)?$/.test(path)) return 100;
  if (method === 'GET' && /\/quests\//.test(path)) return 90;
  if (/\/video-progress$|\/heartbeat$/.test(path)) return 80;
  if (/\/enroll$/.test(path)) return 70;
  return method === 'GET' ? 60 : 50;
}

function retryDelayMs(response) {
  const seconds = headerNumber(response.headers, 'retry-after')
    ?? headerNumber(response.headers, 'x-ratelimit-reset-after');
  return seconds == null ? 0 : Math.min(MAX_RESET_DELAY_MS, Math.ceil(seconds * 1000));
}

function questArray(candidate) {
  if (Array.isArray(candidate)) return candidate;
  if (candidate && typeof candidate === 'object' && Array.isArray(candidate.quests)) {
    return candidate.quests;
  }
  return null;
}

function schedulingQuest(raw, enrollmentBlockedUntil) {
  const questConfig = raw?.config ?? {};
  const userStatus = raw?.user_status ?? {};
  return {
    id: raw?.id ?? 'unknown',
    startsAt: questConfig.starts_at ?? null,
    expiresAt: questConfig.expires_at ?? null,
    enrollmentBlockedUntil,
    enrolled: Boolean(userStatus.enrolled_at),
    completed: Boolean(userStatus.completed_at),
    claimed: Boolean(userStatus.claimed_at) || userStatus.orb_quantity_claimed != null,
  };
}

function isQuestListRequest(task) {
  if (task.method !== 'GET') return false;
  const path = new URL(task.url).pathname.replace(/^\/api\/v\d+/, '');
  return path === '/quests/@me' || path === '/users/@me/quests';
}

async function publishQuestSchedule(task, response) {
  if (!response.ok || !isQuestListRequest(task)) return;
  const candidate = await response.clone().json().catch(() => null);
  const quests = questArray(candidate);
  if (!quests) return;
  const enrollmentBlockedUntil = candidate?.quest_enrollment_blocked_until ?? null;
  const hint = chooseNextQuestAction({
    quests: quests.map((quest) => schedulingQuest(quest, enrollmentBlockedUntil)),
  });
  publishScheduleHint(task.account, hint);
}

export class DiscordRateLimitCoordinator {
  constructor({ maxConcurrency = DEFAULT_MAX_CONCURRENCY, now = Date.now } = {}) {
    this.maxConcurrency = maxConcurrency;
    this.now = now;
    this.queue = [];
    this.sequence = 0;
    this.activeCount = 0;
    this.activeAccounts = new Set();
    this.routeBuckets = new Map();
    this.bucketResetAt = new Map();
    this.globalResetAt = 0;
    this.wakeupTimer = null;
    this.stats = {
      queued: 0,
      active: 0,
      completed: 0,
      rateLimited: 0,
      globalRateLimits: 0,
      lastRateLimitAt: null,
      lastScheduleHintAt: null,
    };
  }

  schedule(url, options, execute) {
    const method = String(options?.method ?? 'GET').toUpperCase();
    const task = {
      id: ++this.sequence,
      url,
      options,
      execute,
      method,
      account: authorizationFingerprint(options?.headers),
      route: routeKey(url, method),
      priority: requestPriority(url, method),
    };

    return new Promise((resolve, reject) => {
      this.queue.push({ ...task, resolve, reject });
      this.queue.sort((left, right) => (
        right.priority - left.priority || left.id - right.id
      ));
      this.stats.queued = this.queue.length;
      this.pump();
    });
  }

  blockedUntil(task) {
    const bucket = this.routeBuckets.get(task.route) ?? task.route;
    return Math.max(this.globalResetAt, this.bucketResetAt.get(bucket) ?? 0);
  }

  nextRunnableIndex() {
    const now = this.now();
    return this.queue.findIndex((task) => (
      !this.activeAccounts.has(task.account) && this.blockedUntil(task) <= now
    ));
  }

  scheduleWakeup() {
    if (this.wakeupTimer || !this.queue.length) return;
    const now = this.now();
    const waits = this.queue
      .filter((task) => !this.activeAccounts.has(task.account))
      .map((task) => this.blockedUntil(task))
      .filter((timestamp) => timestamp > now);
    if (!waits.length) return;
    const delay = Math.max(1, Math.min(...waits) - now);
    this.wakeupTimer = setTimeout(() => {
      this.wakeupTimer = null;
      this.pump();
    }, delay);
    this.wakeupTimer.unref?.();
  }

  updateRateLimitState(task, response) {
    const bucket = response.headers?.get?.('x-ratelimit-bucket');
    if (bucket) this.routeBuckets.set(task.route, bucket);
    const resolvedBucket = bucket ?? this.routeBuckets.get(task.route) ?? task.route;
    const remaining = headerNumber(response.headers, 'x-ratelimit-remaining');
    const delay = retryDelayMs(response);

    if (remaining === 0 && delay > 0) {
      this.bucketResetAt.set(resolvedBucket, this.now() + delay);
    }

    if (response.status === 429) {
      this.stats.rateLimited++;
      this.stats.lastRateLimitAt = new Date(this.now()).toISOString();
      if (String(response.headers?.get?.('x-ratelimit-global')).toLowerCase() === 'true') {
        this.globalResetAt = this.now() + Math.max(1, delay);
        this.stats.globalRateLimits++;
      } else if (delay > 0) {
        this.bucketResetAt.set(resolvedBucket, this.now() + delay);
      }
    }
  }

  run(task) {
    this.activeCount++;
    this.activeAccounts.add(task.account);
    this.stats.active = this.activeCount;
    this.stats.queued = this.queue.length;

    void Promise.resolve()
      .then(() => task.execute())
      .then((response) => {
        this.updateRateLimitState(task, response);
        void publishQuestSchedule(task, response).then(() => {
          if (isQuestListRequest(task)) {
            this.stats.lastScheduleHintAt = new Date(this.now()).toISOString();
          }
        });
        task.resolve(response);
      }, task.reject)
      .finally(() => {
        this.activeCount--;
        this.activeAccounts.delete(task.account);
        this.stats.active = this.activeCount;
        this.stats.completed++;
        this.pump();
      });
  }

  pump() {
    while (this.activeCount < this.maxConcurrency) {
      const index = this.nextRunnableIndex();
      if (index < 0) break;
      const [task] = this.queue.splice(index, 1);
      this.run(task);
    }
    this.stats.queued = this.queue.length;
    this.scheduleWakeup();
  }

  snapshot() {
    return {
      ...this.stats,
      knownRoutes: this.routeBuckets.size,
      blockedBuckets: [...this.bucketResetAt.values()].filter((time) => time > this.now()).length,
      globalBlockedUntil: this.globalResetAt > this.now()
        ? new Date(this.globalResetAt).toISOString()
        : null,
    };
  }
}

export const discordRateLimitCoordinator = new DiscordRateLimitCoordinator();
