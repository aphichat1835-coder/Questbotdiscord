import { authorizationFingerprint } from './authorization-fingerprint.js';
import { verifyRunnerMutationFromQuests } from './durable-mutation-verifier.js';
import { resolveRunnerJobKey } from './runner-execution-context.js';
import { assertRunnerMutationOwnership } from './runner-ownership-guard.js';
import {
  markRunnerMutationAccepted,
  markRunnerMutationFailed,
  markRunnerMutationInFlight,
  markRunnerMutationUncertain,
  prepareRunnerMutation,
  RUNNER_MUTATION_KIND,
  RUNNER_STATE,
  transitionRunnerState,
} from './runner-state-store.js';
import { chooseNextQuestAction } from './smart-scheduler.js';
import { publishScheduleHint } from './schedule-hint-bus.js';

export { authorizationFingerprint } from './authorization-fingerprint.js';

const RATE_LIMIT_FALLBACK_MS = 1000;
const DEFAULT_MAX_CONCURRENCY = 4;
const DEFAULT_CIRCUIT_FAILURE_THRESHOLD = 3;
const DEFAULT_CIRCUIT_OPEN_MS = 30_000;
const DEFAULT_CIRCUIT_MAX_OPEN_MS = 5 * 60_000;
const CIRCUIT_STATE = Object.freeze({
  CLOSED: 'CLOSED',
  OPEN: 'OPEN',
  HALF_OPEN: 'HALF_OPEN',
});
const CIRCUIT_STATE_RANK = new Map([
  [CIRCUIT_STATE.CLOSED, 0],
  [CIRCUIT_STATE.HALF_OPEN, 1],
  [CIRCUIT_STATE.OPEN, 2],
]);

function mergeCircuitEntries(left, right) {
  if (!left) return right ? { ...right } : null;
  if (!right) return { ...left };
  const state = (CIRCUIT_STATE_RANK.get(left.state) ?? 0)
    >= (CIRCUIT_STATE_RANK.get(right.state) ?? 0)
    ? left.state
    : right.state;
  return {
    state,
    failures: Math.max(left.failures ?? 0, right.failures ?? 0),
    opens: Math.max(left.opens ?? 0, right.opens ?? 0),
    openUntil: Math.max(left.openUntil ?? 0, right.openUntil ?? 0),
    probeActive: Boolean(left.probeActive || right.probeActive),
  };
}

export class RunnerMutationCheckpointError extends Error {
  constructor(stage, cause) {
    super(`Runner mutation checkpoint failed during ${stage}: ${cause?.message ?? 'unknown storage error'}`, {
      cause,
    });
    this.name = 'RunnerMutationCheckpointError';
    this.code = 'RUNNER_MUTATION_CHECKPOINT_FAILED';
    this.stage = stage;
  }
}

export class RunnerMutationBlockedError extends Error {
  constructor(jobKey) {
    super(`Runner ${jobKey} must fetch fresh Quest state before another mutation`);
    this.name = 'RunnerMutationBlockedError';
    this.code = 'RUNNER_MUTATION_REQUIRES_VERIFICATION';
    this.jobKey = jobKey;
  }
}

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
  if (path.endsWith('/claim') || path.endsWith('/claim-reward')) return 100;
  if (method === 'GET' && path.includes('/quests/')) return 90;
  if (path.endsWith('/video-progress') || path.endsWith('/heartbeat')) return 80;
  if (path.endsWith('/enroll')) return 70;
  return method === 'GET' ? 60 : 50;
}

async function retryDelayMs(response) {
  const seconds = headerNumber(response.headers, 'retry-after')
    ?? headerNumber(response.headers, 'x-ratelimit-reset-after');
  if (seconds != null) return Math.ceil(seconds * 1000);
  if (response.status !== 429) return 0;
  try {
    const body = await response.clone().json();
    const bodySeconds = Number(body?.retry_after);
    if (Number.isFinite(bodySeconds) && bodySeconds >= 0) {
      return Math.ceil(bodySeconds * 1000);
    }
  } catch {}
  return RATE_LIMIT_FALLBACK_MS;
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

async function publishQuestSchedule(task, response) {
  if (!response.ok || !isQuestListRequest(task)) {
    return { published: false, verification: null };
  }
  const candidate = await response.clone().json().catch(() => null);
  const quests = questArray(candidate);
  if (!quests) return { published: false, verification: null };
  const verification = task.jobKey
    ? verifyRunnerMutationFromQuests(task.jobKey, quests)
    : null;
  const enrollmentBlockedUntil = candidate?.quest_enrollment_blocked_until ?? null;
  const hint = chooseNextQuestAction({
    quests: quests.map((quest) => schedulingQuest(quest, enrollmentBlockedUntil)),
  });
  publishScheduleHint(task.account, { ...hint, source: 'quest-list' });
  return { published: true, verification };
}

function responseError(response) {
  const error = new Error(`Discord API ${response.status}`);
  error.status = response.status;
  return error;
}

function abortError() {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

function checkpointError(stage, error) {
  return error instanceof RunnerMutationCheckpointError
    ? error
    : new RunnerMutationCheckpointError(stage, error);
}

function verificationAllowsNextMutation(verification) {
  return !verification
    || verification.checked === false
    || verification.verified === true
    || verification.retryAllowed === true;
}

function responseRateLimitScope(response, fallbackScope) {
  const announced = String(
    response.headers?.get?.('x-ratelimit-scope') ?? fallbackScope,
  ).toLowerCase();
  if (['user', 'shared', 'global'].includes(announced)) return announced;
  return fallbackScope;
}

function responseIsGlobalRateLimit(response, scope) {
  if (response.status !== 429) return false;
  return String(response.headers?.get?.('x-ratelimit-global')).toLowerCase() === 'true'
    || scope === 'global';
}

function resolvedRateLimitDelay(remaining, parsedDelay) {
  if (remaining === 0 && parsedDelay === 0) return RATE_LIMIT_FALLBACK_MS;
  return parsedDelay;
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
    this.blockedMutationJobs = new Set();
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
      ownershipLosses: 0,
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

    if (options?.signal?.aborted) return Promise.reject(abortError());

    if (task.jobKey && mutation) {
      try {
        assertRunnerMutationOwnership(task.jobKey, this.now());
      } catch (error) {
        this.stats.ownershipLosses++;
        return Promise.reject(error);
      }
    }

    if (task.jobKey && mutation && this.blockedMutationJobs.has(task.jobKey)) {
      return Promise.reject(new RunnerMutationBlockedError(task.jobKey));
    }

    if (task.jobKey && mutation) {
      try {
        prepareRunnerMutation(task.jobKey, mutation);
      } catch (error) {
        if (error?.code === 'RUNNER_MUTATION_REQUIRES_VERIFICATION') {
          this.blockedMutationJobs.add(task.jobKey);
          return Promise.reject(new RunnerMutationBlockedError(task.jobKey));
        }
        this.stats.checkpointErrors++;
        return Promise.reject(checkpointError('prepare', error));
      }
    }

    return new Promise((resolve, reject) => {
      const queuedTask = { ...task, resolve, reject, detachAbort: null };
      const onAbort = () => {
        const index = this.queue.indexOf(queuedTask);
        if (index < 0) return;
        this.queue.splice(index, 1);
        queuedTask.detachAbort?.();
        const error = abortError();
        if (task.jobKey && task.mutation) {
          try {
            markRunnerMutationFailed(task.jobKey, error, { state: RUNNER_STATE.RUNNING });
          } catch {
            this.stats.checkpointErrors++;
          }
        }
        this.stats.queued = this.queue.length;
        reject(error);
        this.pump();
      };
      if (options?.signal) {
        options.signal.addEventListener('abort', onAbort, { once: true });
        queuedTask.detachAbort = () => options.signal.removeEventListener('abort', onAbort);
      }
      this.queue.push(queuedTask);
      this.queue.sort((left, right) => (
        right.priority - left.priority || left.id - right.id
      ));
      this.stats.queued = this.queue.length;
      if (options?.signal?.aborted) onAbort();
      else this.pump();
    });
  }

  routeScope(task) {
    return this.routeScopes.get(task.route) ?? 'shared';
  }

  resolvedBucket(task) {
    return this.routeBuckets.get(task.route) ?? task.route;
  }

  circuitKeyFor(task, bucket, scope) {
    return scope === 'user'
      ? `${task.account}:${bucket}`
      : `shared:${bucket}`;
  }

  circuitKey(task) {
    return this.circuitKeyFor(task, this.resolvedBucket(task), this.routeScope(task));
  }

  resetEntry(task, bucket, scope) {
    return scope === 'user'
      ? { map: this.accountBucketResetAt, key: `${task.account}:${bucket}` }
      : { map: this.bucketResetAt, key: bucket };
  }

  migrateRouteState(task, previousBucket, previousScope) {
    const nextBucket = this.resolvedBucket(task);
    const nextScope = this.routeScope(task);
    const previousCircuitKey = this.circuitKeyFor(task, previousBucket, previousScope);
    const nextCircuitKey = this.circuitKeyFor(task, nextBucket, nextScope);
    if (previousCircuitKey !== nextCircuitKey) {
      const merged = mergeCircuitEntries(
        this.circuits.get(previousCircuitKey),
        this.circuits.get(nextCircuitKey),
      );
      if (merged) this.circuits.set(nextCircuitKey, merged);
      this.circuits.delete(previousCircuitKey);
    }

    const previousReset = this.resetEntry(task, previousBucket, previousScope);
    const nextReset = this.resetEntry(task, nextBucket, nextScope);
    if (previousReset.map !== nextReset.map || previousReset.key !== nextReset.key) {
      const previousResetAt = previousReset.map.get(previousReset.key);
      if (previousResetAt != null) {
        nextReset.map.set(
          nextReset.key,
          Math.max(nextReset.map.get(nextReset.key) ?? 0, previousResetAt),
        );
        previousReset.map.delete(previousReset.key);
      }
    }
  }

  circuitBlockedUntil(task) {
    const circuit = this.circuits.get(this.circuitKey(task));
    if (!circuit || circuit.state === CIRCUIT_STATE.CLOSED) return 0;
    if (circuit.state === CIRCUIT_STATE.HALF_OPEN && circuit.probeActive) {
      return Number.POSITIVE_INFINITY;
    }
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
    if (delay <= 0) return;
    const entry = this.resetEntry(task, bucket, scope);
    const resetAt = Math.max(entry.map.get(entry.key) ?? 0, this.now() + delay);
    entry.map.set(entry.key, resetAt);
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

  resolveResponseRateLimitRoute(task, response) {
    const previousBucket = this.resolvedBucket(task);
    const previousScope = this.routeScope(task);
    const announcedBucket = response.headers?.get?.('x-ratelimit-bucket');
    if (announcedBucket) this.routeBuckets.set(task.route, announcedBucket);
    const resolvedBucket = announcedBucket ?? this.routeBuckets.get(task.route) ?? task.route;
    const scope = responseRateLimitScope(response, previousScope);
    this.routeScopes.set(task.route, scope);
    this.migrateRouteState(task, previousBucket, previousScope);
    return { resolvedBucket, scope };
  }

  recordRateLimitResponse(response) {
    if (response.status !== 429) return;
    this.stats.rateLimited++;
    this.stats.lastRateLimitAt = new Date(this.now()).toISOString();
  }

  applyGlobalRateLimit(task, delay) {
    const resetDelay = Math.max(RATE_LIMIT_FALLBACK_MS, delay);
    this.globalResetAt = Math.max(this.globalResetAt, this.now() + resetDelay);
    this.stats.globalRateLimits++;
    const nextActionAt = new Date(this.globalResetAt).toISOString();
    if (task.jobKey) {
      transitionRunnerState(task.jobKey, RUNNER_STATE.WAITING_RATE_LIMIT, {
        nextActionAt,
        stateSource: 'rate-limit:global',
      });
    }
    publishScheduleHint(task.account, {
      nextActionAt,
      reason: 'rate-limit',
      priority: 98,
      source: 'rate-limit',
      expiresAt: new Date(this.globalResetAt + 60_000).toISOString(),
    });
  }

  applyBucketRateLimit(task, status, { remaining, delay, resolvedBucket, scope }) {
    const bucketDelay = status === 429
      ? Math.max(RATE_LIMIT_FALLBACK_MS, delay)
      : delay;
    if (bucketDelay <= 0) return;
    if (remaining !== 0 && status !== 429) return;
    this.setBucketReset(task, resolvedBucket, bucketDelay, scope);
  }

  async updateRateLimitState(task, response) {
    const { resolvedBucket, scope } = this.resolveResponseRateLimitRoute(task, response);
    const remaining = headerNumber(response.headers, 'x-ratelimit-remaining');
    const shouldReadDelay = response.status === 429 || remaining === 0;
    const parsedDelay = shouldReadDelay ? await retryDelayMs(response) : 0;
    const delay = resolvedRateLimitDelay(remaining, parsedDelay);
    this.recordRateLimitResponse(response);
    if (responseIsGlobalRateLimit(response, scope)) {
      this.applyGlobalRateLimit(task, delay);
      return;
    }
    this.applyBucketRateLimit(task, response.status, {
      remaining,
      delay,
      resolvedBucket,
      scope,
    });
  }


  enterHalfOpen(task) {
    const key = this.circuitKey(task);
    const circuit = this.circuits.get(key);
    if (circuit?.state !== CIRCUIT_STATE.OPEN || circuit.openUntil > this.now()) return;
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
    const delay = Math.min(
      this.circuitMaxOpenMs,
      this.circuitOpenMs * (2 ** Math.max(0, opens - 1)),
    );
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
      this.blockedMutationJobs.add(task.jobKey);
      return;
    }
    const error = responseError(response);
    if (response.status === 429 || response.status >= 500) {
      markRunnerMutationUncertain(task.jobKey, error, new Date(this.now()));
      this.blockedMutationJobs.add(task.jobKey);
    } else {
      markRunnerMutationFailed(task.jobKey, error, { state: RUNNER_STATE.RUNNING });
      this.blockedMutationJobs.delete(task.jobKey);
    }
  }

  async publishSchedule(task, response) {
    const result = await publishQuestSchedule(task, response);
    if (!result.published) return false;
    this.stats.lastScheduleHintAt = new Date(this.now()).toISOString();
    if (task.jobKey && verificationAllowsNextMutation(result.verification)) {
      this.blockedMutationJobs.delete(task.jobKey);
    }
    return true;
  }

  async handleResponse(task, response) {
    try {
      await this.updateRateLimitState(task, response);
    } catch {
      this.stats.bookkeepingErrors++;
    }

    try {
      this.updateCircuitFromResponse(task, response);
    } catch {
      this.stats.bookkeepingErrors++;
    }

    try {
      this.updateMutationFromResponse(task, response);
    } catch {
      this.stats.checkpointErrors++;
      if (task.jobKey && task.mutation) this.blockedMutationJobs.add(task.jobKey);
    }

    try {
      await this.publishSchedule(task, response);
    } catch {
      this.stats.scheduleHintErrors++;
    }
    task.resolve(response);
  }

  handleFailure(task, error) {
    try {
      this.recordCircuitFailure(task);
    } catch {
      this.stats.bookkeepingErrors++;
    }
    if (task.jobKey && task.mutation) {
      try {
        markRunnerMutationUncertain(task.jobKey, error, new Date(this.now()));
        this.blockedMutationJobs.add(task.jobKey);
      } catch {
        this.stats.checkpointErrors++;
        this.blockedMutationJobs.add(task.jobKey);
      }
    }
    task.reject(error);
  }

  finishTask(task) {
    const circuit = this.circuits.get(this.circuitKey(task));
    if (circuit?.state === CIRCUIT_STATE.HALF_OPEN) circuit.probeActive = false;
    this.activeCount--;
    this.activeAccounts.delete(task.account);
    this.stats.active = this.activeCount;
    this.stats.completed++;
    this.pump();
  }

  run(task) {
    task.detachAbort?.();
    this.activeCount++;
    this.activeAccounts.add(task.account);
    this.enterHalfOpen(task);
    this.stats.active = this.activeCount;
    this.stats.queued = this.queue.length;

    if (task.jobKey && task.mutation) {
      try {
        assertRunnerMutationOwnership(task.jobKey, this.now());
        markRunnerMutationInFlight(task.jobKey, new Date(this.now()));
      } catch (error) {
        if (error?.code === 'RUNNER_OWNERSHIP_LOST') {
          this.stats.ownershipLosses++;
          task.reject(error);
        } else {
          this.stats.checkpointErrors++;
          task.reject(checkpointError('in-flight', error));
        }
        this.finishTask(task);
        return;
      }
    }

    void Promise.resolve()
      .then(() => task.execute())
      .then(
        (response) => this.handleResponse(task, response),
        (error) => this.handleFailure(task, error),
      )
      .finally(() => this.finishTask(task));
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
      blockedMutationJobs: this.blockedMutationJobs.size,
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
