from pathlib import Path

bootstrap = Path('bot/src/bootstrap.js').read_text(encoding='utf-8')
if 'export function serializeBootstrapContext(context)' not in bootstrap:
    raise SystemExit('bootstrap serializer fix is missing')
if 'serializedContext = String(context)' in bootstrap:
    raise SystemExit('unsafe bootstrap object stringification remains')

architecture = Path('bot/test/quest-architecture-boundaries.node-test.js').read_text(
    encoding='utf-8',
)
if 'function declarationBlocks(moduleSource, prefix)' not in architecture:
    raise SystemExit('architecture parser cleanup is missing')
if 'start = end;' in architecture:
    raise SystemExit('unused start assignment remains')

coordinator_path = Path('bot/src/quest/rate-limit-coordinator.js')
coordinator = coordinator_path.read_text(encoding='utf-8')
start_marker = '\n  resolveResponseRateLimitRoute(task, response) {\n'
end_marker = '\n\n  enterHalfOpen(task) {'
if coordinator.count(start_marker) != 1 or coordinator.count(end_marker) != 1:
    raise SystemExit('rate-limit response helper boundaries are not unique')

formatted_block = """  resolveResponseRateLimitRoute(task, response) {
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
"""
start = coordinator.index(start_marker) + 1
end = coordinator.index(end_marker, start)
coordinator_path.write_text(
    coordinator[:start] + formatted_block + coordinator[end:],
    encoding='utf-8',
)
