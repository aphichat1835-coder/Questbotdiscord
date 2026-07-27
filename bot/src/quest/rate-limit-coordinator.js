import { authorizationFingerprint } from './authorization-fingerprint.js';
import { resolveRunnerJobKey } from './runner-execution-context.js';
import {
  getRunnerState,
  markRunnerMutationAccepted,
  markRunnerMutationFailed,
  markRunnerMutationInFlight,
  markRunnerMutationUncertain,
  markRunnerMutationVerified,
  prepareRunnerMutation,
  RUNNER_MUTATION_KIND,
  RUNNER_MUTATION_STATUS,
  RUNNER_STATE,
  transitionRunnerState,
} from './runner-state-store.js';
import { chooseNextQuestAction } from './smart-scheduler.js';
import { publishScheduleHint } from './schedule-hint-bus.js';

export { authorizationFingerprint } from './authorization-fingerprint.js';

const MAX_RESET_DELAY_MS = 60_000;
const DEFAULT_MAX_CONCURRENCY = 4;
const DEFAULT_CIRCUIT_FAILURE_THRESHOLD = 3;
const DEFAULT_CIRCUIT_OPEN_MS = 30_000;
const DEFAULT_CIRCUIT_MAX_OPEN_MS = 5 * 60_000;
const CIRCUIT_STATE = Object.freeze({
  CLOSED: 'CLOSED',
  OPEN: 'OPEN',
  HALF_OPEN: 'HALF_OPEN',
});
const VERIFYABLE_MUTATION_STATUSES = new Set([
  RUNNER_MUTATION_STATUS.PREPARED,
  RUNNER_MUTATION_STATUS.IN_FLIGHT,
  RUNNER_MUTATION_STATUS.ACCEPTED,
  RUNNER_MUTATION_STATUS.UNCERTAIN,
]);

function headerNumber(headers, name) {
  const value = Number.parseFloat(headers?.get?.(name));
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function routeKey(url, method) {
  const parsed = new URL(url);
  const normalized = parsed.pathname
    .replace(/^\/api\/v\d+/, '')
    .replace(/^\/quests\/(?!@me(?:\/|$))[^/]+/, '/quests/:questId')
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

async function retryDelayMs(response) {
  const seconds = headerNumber(response.headers, 'retry-after')
    ?? headerNumber(response.headers, 'x-ratelimit-reset-after');
  if (seconds != null) return Math.min(MAX_RESET_DELAY_MS, Math.ceil(seconds * 1000));
  try {
    const body = await response.clone().json();
    const bodySeconds = Number(body?.retry_after);
    if (Number.isFinite(bodySeconds) && bodySeconds >= 0) {
      return Math.min(MAX_RESET_DELAY_MS, Math.ceil(bodySeconds * 1000));
    }
  } catch {}
  return 0;
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

function parseRequestBody(options) {
  if (typeof options?.body !== 'string' || options.body.length > 10_000) return null;
  try {
    const parsed = JSON.parse(options.body);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function mutationFromRequest(url, method, options) {
  if (method !== 'POST') return null;
  const path = new URL(url).pathname.replace(/^\/api\/v\d+/, '');
  const match = /^\/quests\/([^/]+)\/(enroll|video-progress|heartbeat|claim-reward|claim)$/.exec(path);
  if (!match) return null;
  const kind = {
    enroll: RUNNER_MUTATION_KIND.ENROLL,
    'video-progress': RUNNER_MUTATION_KIND.VIDEO_PROGRESS,
    heartbeat: RUNNER_MUTATION_KIND.HEARTBEAT,
    'claim-reward': RUNNER_MUTATION_KIND.CLAIM,
    claim: RUNNER_MUTATION_KIND.CLAIM,
  }[match[2]];
  return {
    kind,
    questId: match[1],
    payload: parseRequestBody(options),
  };
}

function maxNumericProgress(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (!value || typeof value !== 'object') return 0;
  if (Array.isArray(value)) return Math.max(0, ...value.map(maxNumericProgress));
  return Math.max(0, ...Object.values(value).map((entry) => (
    entry && typeof entry === 'object' && Object.hasOwn(entry, 'value')
      ? maxNumericProgress(entry.value)
      : maxNumericProgress(entry)
  )));
}

function rawQuestProgress(raw) {
  const userStatus = raw?.user_status ?? {};
  return Math.max(
    maxNumericProgress(userStatus.progress),
    Number(userStatus.stream_progress_seconds) || 0,
  );
}

function mutationVerifiedByQuest(state, rawQuest) {
  if (!state?.mutation_kind || !rawQuest) return false;
  const status = rawQuest.user_status ?? {};
  if (state.mutation_kind === RUNNER_MUTATION_KIND.ENROLL) return Boolean(status.enrolled_at);
  if (state.mutation_kind === RUNNER_MUTATION_KIND.CLAIM) {
    return Boolean(status.claimed_at) || status.orb_quantity_claimed != null;
  }
  if (status.completed_at) return true;
  const progress = rawQuestProgress(rawQuest);
  if (state.mutation_kind === RUNNER_MUTATION_KIND.VIDEO_PROGRESS) {
    const target = Number(state.mutation_payload?.timestamp);
    return Number.isFinite(target) && progress >= Math.floor(target);
  }
  if (state.mutation_kind === RUNNER_MUTATION_KIND.HEARTBEAT) {
    return progress > Number(state.server_progress_seconds ?? 0);
  }
  return false;
}

function verifyDurableMutation(task, quests) {
  if (!task.jobKey) return false;
  const state = getRunnerState(task.jobKey);
  if (!state?.quest_id || !VERIFYABLE_MUTATION_STATUSES.has(state.mutation_status)) return false;
  const rawQuest = quests.find((quest) => String(quest?.id) === String(state.quest_id));
  if (!mutationVerifiedByQuest(state, rawQuest)) return false;
  const serverProgressSeconds = rawQuestProgress(rawQuest);
  markRunnerMutationVerified(task.jobKey, {
    serverProgressSeconds,
    state: rawQuest?.user_status?.completed_at
      ? RUNNER_STATE.VERIFYING_COMPLETION
      : RUNNER_STATE.RUNNING,
  });
  return true;
}

async function publishQuestSchedule(task, response) {
  if (!response.ok || !isQuestListRequest(task)) return false;
  const candidate = await response.clone().json().catch(() => null);
  const quests = questArray(candidate);
  if (!quests) return false;
  verifyDurableMutation(task, quests);
  const enrollmentBlockedUntil = candidate?.quest_enrollment_blocked_until ?? null;
  const hint = chooseNextQuestAction({
    quests: quests.map((quest) => schedulingQuest(quest, enrollmentBlockedUntil)),
  });
  publishScheduleHint(task.account, { ...hint, source: 'quest-list' });
  return true;
}

function responseError(response) {
  const error = new Error(`Discord API ${response.status}`);
  error.status = response.status;
  return error;
}

export class DiscordRateLimitCoordinator {
  constructor({
    maxConcurrency = DEFAULT_MAX_CONCURRENCY,
    now = Date.now,
    circuitFailureThreshold = DEFAULT_CIRCUIT_FAILURE_THRESHOLD,
    circuitOpenMs = DEFAULT_CIRCUIT_OPEN_MS,
    circuitMaxOpenMs = DEFAULT_CIRCUIT_MAX_OPEN_MS,
  } = {}) {
    this.maxConcurrency = maxConcurrency;
    this.now = now;
    this.circuitFailureThreshold = circuitFailureThreshold;
    this.circuitOpenMs = circuitOpenMs;
    this.circuitMaxOpenMs = circuitMaxOpenMs;
    this.queue = [];
    this.sequence = 0;
    this.activeCount = 0;
    this.activeAccounts = new Set();
    this.routeBuckets = new Map();
    this.routeScopes = new Map();
    this.bucketResetAt = new Map();
    this.accountBucketResetAt = new Map();
    this.globalResetAt = 0;
    this.circuits = new Map();
    this.wakeupTimer = null;
    this.stats = {
      queued: 0,
      active: 0,
      completed: 0,
      rateLimited: 0,
      globalRateLimits: 0,
      bookkeepingErrors: 0,
      scheduleHintErrors: 0,
      checkpointErrors: 0,
      circuitOpens: 0,
      lastRateLimitAt: null,
      lastScheduleHintAt: null,
      lastCircuitOpenAt: null,
    };
  }

  schedule(url, options, execute) {
    const method = String(options?.method ?? 'GET').toUpperCase();
    const account = authorizationFingerprint(options?.headers);
    const mutation = mutationFromRequest(url, method, options);
    const task = {
      id: ++this.sequence,
      url,
      options,
      execute,
      method,
      account,
      jobKey: resolveRunnerJobKey(account),
      route: routeKey(url, method),
      priority: requestPriority(url, method),
      mutation,
    };

    if (task.jobKey && mutation) {
      try {
        prepareRunnerMutation(task.jobKey, mutation);
      } catch {
        this.stats.checkpointErrors++;
      }
    }

    return new Promise((resolve, reject) => {
      this.queue.push({ ...task, resolve, reject });
      this.queue.sort((left, right) => (
        right.priority - left.priority || left.id - right.id
      ));
      this.stats.queued = this.queue.length;
      this.pump();
    });
  }

  routeScope(task) {
    return this.routeScopes.get(task.route) ?? 'shared';
  }

  resolvedBucket(task) {
    return this.routeBuckets.get(task.route) ?? task.route;
  }

  circuitKey(task) {
    const bucket = this.resolvedBucket(task);
    return this.routeScope(task) === 'shared'
      ? `shared:${bucket}`
      : `${task.account}:${bucket}`;
  }

  circuitBlockedUntil(task) {
    const circuit = this.circuits.get(this.circuitKey(task));
    if (!circuit || circuit.state === CIRCUIT_STATE.CLOSED) return 0;
    if (circuit.state === CIRCUIT_STATE.HALF_OPEN && circuit.probeActive) return Number.POSITIVE_INFINITY;
    return circuit.openUntil ?? 0;
  }

  bucketBlockedUntil(task) {
    const bucket = this.resolvedBucket(task);
    if (this.routeScope(task) === 'user') {
      return this.accountBucketResetAt.get(`${task.account}:${bucket}`) ?? 0;
    }
    return this.bucketResetAt.get(bucket) ?? 0;
  }

  blockedUntil(task) {
    return Math.max(
      this.globalResetAt,
      this.bucketBlockedUntil(task),
      this.circuitBlockedUntil(task),
    );
  }

  nextRunnableIndex() {
    const now = this.now();
    return this.queue.findIndex((task) => (
      !this.activeAccounts.has(task.account) && this.blockedUntil(task) <= now
    ));
  }

  scheduleWakeup() {
    if (this.wakeupTimer) {
      clearTimeout(this.wakeupTimer);
      this.wakeupTimer = null;
    }
    if (!this.queue.length) return;
    const now = this.now();
    const waits = this.queue
      .filter((task) => !this.activeAccounts.has(task.account))
      .map((task) => this.blockedUntil(task))
      .filter((timestamp) => Number.isFinite(timestamp) && timestamp > now);
    if (!waits.length) return;
    const delay = Math.max(1, Math.min(...waits) - now);
    this.wakeupTimer = setTimeout(() => {
      this.wakeupTimer = null;
      this.pump();
    }, delay);
  }

  setBucketReset(task, bucket, delay, scope) {
    if (!(delay > 0)) return;
    const resetAt = this.now() + delay;
    if (scope === 'user') {
      this.accountBucketResetAt.set(`${task.account}:${bucket}`, resetAt);
    } else {
      this.bucketResetAt.set(bucket, resetAt);
    }
    publishScheduleHint(task.account, {
      nextActionAt: new Date(resetAt).toISOString(),
      reason: 'rate-limit',
      priority: 98,
      source: 'rate-limit',
      expiresAt: new Date(resetAt + 60_000).toISOString(),
    });
    if (task.jobKey) {
      transitionRunnerState(task.jobKey, RUNNER_STATE.WAITING_RATE_LIMIT, {
        nextActionAt: new Date(resetAt).toISOString(),
        stateSource: `rate-limit:${scope}`,
      });
    }
  }

  async updateRateLimitState(task, response) {
    const bucket = response.headers?.get?.('x-ratelimit-bucket');
    if (bucket) this.routeBuckets.set(task.route, bucket);
    const resolvedBucket = bucket ?? this.routeBuckets.get(task.route) ?? task.route;
    const scope = String(response.headers?.get?.('x-ratelimit-scope') ?? this.routeScopes.get(task.route) ?? 'shared')
      .toLowerCase();
    if (['user', 'shared', 'global'].includes(scope)) this.routeScopes.set(task.route, scope);
    const remaining = headerNumber(response.headers, 'x-ratelimit-remaining');
    const delay = await retryDelayMs(response);

    if (remaining === 0 && delay > 0) this.setBucketReset(task, resolvedBucket, delay, scope);

    if (response.status === 429) {
      this.stats.rateLimited++;
      this.stats.lastRateLimitAt = new Date(this.now()).toISOString();
      if (
        String(response.headers?.get?.('x-ratelimit-global')).toLowerCase() === 'true'
        || scope === 'global'
      ) {
        this.globalResetAt = this.now() + Math.max(1, delay);
        this.stats.globalRateLimits++;
        publishScheduleHint(task.account, {
          nextActionAt: new Date(this.globalResetAt).toISOString(),
          reason: 'rate-limit',
          priority: 98,
          source: 'rate-limit',
          expiresAt: new Date(this.globalResetAt + 60_000).toISOString(),
        });
      } else if (delay > 0) {
        this.setBucketReset(task, resolvedBucket, delay, scope);
      }
    }
  }

  enterHalfOpen(task) {
    const key = this.circuitKey(task);
    const circuit = this.circuits.get(key);
    if (!circuit || circuit.state !== CIRCUIT_STATE.OPEN || circuit.openUntil > this.now()) return;
    circuit.state = CIRCUIT_STATE.HALF_OPEN;
    circuit.probeActive = true;
  }

  closeCircuit(task) {
    const key = this.circuitKey(task);
    const circuit = this.circuits.get(key);
    if (!circuit) return;
    this.circuits.set(key, {
      state: CIRCUIT_STATE.CLOSED,
      failures: 0,
      opens: circuit.opens ?? 0,
      openUntil: 0,
      probeActive: false,
    });
  }

  recordCircuitFailure(task) {
    const key = this.circuitKey(task);
    const previous = this.circuits.get(key) ?? {
      state: CIRCUIT_STATE.CLOSED,
      failures: 0,
      opens: 0,
      openUntil: 0,
      probeActive: false,
    };
    const failures = previous.failures + 1;
    if (failures < this.circuitFailureThreshold && previous.state !== CIRCUIT_STATE.HALF_OPEN) {
      this.circuits.set(key, { ...previous, failures, probeActive: false });
      return;
    }
    const opens = previous.opens + 1;
    const delay = Math.min(this.circuitMaxOpenMs, this.circuitOpenMs * (2 ** Math.max(0, opens - 1)));
    const openUntil = this.now() + delay;
    this.circuits.set(key, {
      state: CIRCUIT_STATE.OPEN,
      failures,
      opens,
      openUntil,
      probeActive: false,
    });
    this.stats.circuitOpens++;
    this.stats.lastCircuitOpenAt = new Date(this.now()).toISOString();
    publishScheduleHint(task.account, {
      nextActionAt: new Date(openUntil).toISOString(),
      reason: 'circuit-breaker',
      priority: 92,
      source: 'circuit-breaker',
      expiresAt: new Date(openUntil + 60_000).toISOString(),
    });
  }

  updateCircuitFromResponse(task, response) {
    if (response.status === 429 || response.status >= 500) this.recordCircuitFailure(task);
    else this.closeCircuit(task);
  }

  updateMutationFromResponse(task, response) {
    if (!task.jobKey || !task.mutation) return;
    if (response.ok) {
      markRunnerMutationAccepted(task.jobKey, new Date(this.now()));
      return;
    }
    const error = responseError(response);
    if (response.status === 429 || response.status >= 500) {
      markRunnerMutationUncertain(task.jobKey, error, new Date(this.now()));
    } else {
      markRunnerMutationFailed(task.jobKey, error, { state: RUNNER_STATE.RUNNING });
    }
  }

  publishSchedule(task, response) {
    void publishQuestSchedule(task, response)
      .then((published) => {
        if (published) this.stats.lastScheduleHintAt = new Date(this.now()).toISOString();
      })
      .catch(() => {
        this.stats.scheduleHintErrors++;
      });
  }

  async handleResponse(task, response) {
    try {
      await this.updateRateLimitState(task, response);
      this.updateCircuitFromResponse(task, response);
      this.updateMutationFromResponse(task, response);
    } catch {
      this.stats.bookkeepingErrors++;
    }
    try {
      this.publishSchedule(task, response);
    } catch {
      this.stats.scheduleHintErrors++;
    }
    task.resolve(response);
  }

  handleFailure(task, error) {
    try {
      this.recordCircuitFailure(task);
      if (task.jobKey && task.mutation) markRunnerMutationUncertain(task.jobKey, error, new Date(this.now()));
    } catch {
      this.stats.checkpointErrors++;
    }
    task.reject(error);
  }

  run(task) {
    this.activeCount++;
    this.activeAccounts.add(task.account);
    this.enterHalfOpen(task);
    if (task.jobKey && task.mutation) {
      try {
        markRunnerMutationInFlight(task.jobKey, new Date(this.now()));
      } catch {
        this.stats.checkpointErrors++;
      }
    }
    this.stats.active = this.activeCount;
    this.stats.queued = this.queue.length;

    void Promise.resolve()
      .then(() => task.execute())
      .then(
        (response) => this.handleResponse(task, response),
        (error) => this.handleFailure(task, error),
      )
      .finally(() => {
        const circuit = this.circuits.get(this.circuitKey(task));
        if (circuit?.state === CIRCUIT_STATE.HALF_OPEN) circuit.probeActive = false;
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
    const circuits = [...this.circuits.values()];
    return {
      ...this.stats,
      knownRoutes: this.routeBuckets.size,
      knownScopes: this.routeScopes.size,
      blockedBuckets: [
        ...this.bucketResetAt.values(),
        ...this.accountBucketResetAt.values(),
      ].filter((time) => time > this.now()).length,
      openCircuits: circuits.filter((circuit) => (
        circuit.state === CIRCUIT_STATE.OPEN && circuit.openUntil > this.now()
      )).length,
      halfOpenCircuits: circuits.filter((circuit) => circuit.state === CIRCUIT_STATE.HALF_OPEN).length,
      globalBlockedUntil: this.globalResetAt > this.now()
        ? new Date(this.globalResetAt).toISOString()
        : null,
    };
  }
}

export const discordRateLimitCoordinator = new DiscordRateLimitCoordinator();
