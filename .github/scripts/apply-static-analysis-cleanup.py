from pathlib import Path


def replace_once(path, old, new):
    file = Path(path)
    text = file.read_text(encoding='utf-8')
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected one target, found {count}')
    file.write_text(text.replace(old, new), encoding='utf-8')


bootstrap = 'bot/src/bootstrap.js'
replace_once(
    bootstrap,
    "export const FATAL_REPORT_BUDGET_MS = 3500;\nlet fatalBootstrapPromise = null;\n",
    "export const FATAL_REPORT_BUDGET_MS = 3500;\nlet fatalBootstrapPromise = null;\n\nexport function serializeBootstrapContext(context) {\n  const seen = new WeakSet();\n  try {\n    return JSON.stringify(context, (_key, value) => {\n      if (!value || typeof value !== 'object') return value;\n      if (seen.has(value)) return '[Circular]';\n      seen.add(value);\n      return value;\n    }) ?? '{}';\n  } catch {\n    return '{\\\"serialization\\\":\\\"failed\\\"}';\n  }\n}\n",
)
replace_once(
    bootstrap,
    "  if (fatalBootstrapPromise) {\n    let serializedContext;\n    try {\n      serializedContext = JSON.stringify(context);\n    } catch {\n      serializedContext = String(context);\n    }\n    console.error(\n",
    "  if (fatalBootstrapPromise) {\n    const serializedContext = serializeBootstrapContext(context);\n    console.error(\n",
)

bootstrap_test = 'bot/test/bootstrap.node-test.js'
replace_once(
    bootstrap_test,
    "  reportWithinFatalBudget,\n  resetBootstrapStateForTests,\n",
    "  reportWithinFatalBudget,\n  resetBootstrapStateForTests,\n  serializeBootstrapContext,\n",
)
replace_once(
    bootstrap_test,
    "test.after(() => { console.error = originalConsoleError; });\n\n",
    "test.after(() => { console.error = originalConsoleError; });\n\ntest('bootstrap context serialization handles circular values without default object strings', () => {\n  const context = { component: 'bootstrap' };\n  context.self = context;\n  const serialized = serializeBootstrapContext(context);\n  assert.equal(serialized, '{\\\"component\\\":\\\"bootstrap\\\",\\\"self\\\":\\\"[Circular]\\\"}');\n  assert.doesNotMatch(serialized, /\\[object Object\\]/);\n});\n\n",
)

architecture_test = 'bot/test/quest-architecture-boundaries.node-test.js'
old_parsers = """function namedImports(moduleSource, modulePath) {
  const lines = moduleSource.split('\\n');
  const moduleClause = `from '${modulePath}'`;
  for (let start = 0; start < lines.length; start++) {
    if (!lines[start].trimStart().startsWith('import {')) continue;
    const block = [];
    for (let end = start; end < lines.length; end++) {
      block.push(lines[end]);
      if (!lines[end].trimEnd().endsWith(';')) continue;
      const joined = block.join('\\n');
      if (joined.includes(moduleClause)) return blockNames(joined);
      start = end;
      break;
    }
  }
  return [];
}

function localNamedExports(moduleSource) {
  const lines = moduleSource.split('\\n');
  const names = [];
  for (let start = 0; start < lines.length; start++) {
    if (!lines[start].trimStart().startsWith('export {')) continue;
    const block = [];
    for (let end = start; end < lines.length; end++) {
      block.push(lines[end]);
      const trimmed = lines[end].trimEnd();
      if (!lines[end].includes('}') || !trimmed.endsWith(';')) continue;
      const joined = block.join('\\n');
      if (!joined.includes(' from ')) names.push(...blockNames(joined));
      start = end;
      break;
    }
  }
  return names;
}
"""
new_parsers = """function declarationBlocks(moduleSource, prefix) {
  const lines = moduleSource.split('\\n');
  const blocks = [];
  let index = 0;
  while (index < lines.length) {
    if (!lines[index].trimStart().startsWith(prefix)) {
      index++;
      continue;
    }
    const block = [];
    do {
      block.push(lines[index]);
      index++;
    } while (index < lines.length && !block.at(-1).trimEnd().endsWith(';'));
    blocks.push(block.join('\\n'));
  }
  return blocks;
}

function namedImports(moduleSource, modulePath) {
  const moduleClause = `from '${modulePath}'`;
  const block = declarationBlocks(moduleSource, 'import {')
    .find((candidate) => candidate.includes(moduleClause));
  return block ? blockNames(block) : [];
}

function localNamedExports(moduleSource) {
  return declarationBlocks(moduleSource, 'export {')
    .filter((block) => !block.includes(' from '))
    .flatMap(blockNames);
}
"""
replace_once(architecture_test, old_parsers, new_parsers)

coordinator = 'bot/src/quest/rate-limit-coordinator.js'
replace_once(
    coordinator,
    "function verificationAllowsNextMutation(verification) {\n  return !verification\n    || verification.checked === false\n    || verification.verified === true\n    || verification.retryAllowed === true;\n}\n",
    "function verificationAllowsNextMutation(verification) {\n  return !verification\n    || verification.checked === false\n    || verification.verified === true\n    || verification.retryAllowed === true;\n}\n\nfunction responseRateLimitScope(response, fallbackScope) {\n  const announced = String(\n    response.headers?.get?.('x-ratelimit-scope') ?? fallbackScope,\n  ).toLowerCase();\n  if (['user', 'shared', 'global'].includes(announced)) return announced;\n  return fallbackScope;\n}\n\nfunction responseIsGlobalRateLimit(response, scope) {\n  if (response.status !== 429) return false;\n  return String(response.headers?.get?.('x-ratelimit-global')).toLowerCase() === 'true'\n    || scope === 'global';\n}\n\nfunction resolvedRateLimitDelay(remaining, parsedDelay) {\n  if (remaining === 0 && parsedDelay === 0) return RATE_LIMIT_FALLBACK_MS;\n  return parsedDelay;\n}\n",
)

new_method = """  resolveResponseRateLimitRoute(task, response) {
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
coordinator_file = Path(coordinator)
coordinator_text = coordinator_file.read_text(encoding='utf-8')
start_marker = "\n  async updateRateLimitState(task, response) {\n"
end_marker = "\n\n  enterHalfOpen(task) {"
if coordinator_text.count(start_marker) != 1 or coordinator_text.count(end_marker) != 1:
    raise SystemExit('rate-limit coordinator method boundaries are not unique')
start = coordinator_text.index(start_marker) + 1
end = coordinator_text.index(end_marker, start)
coordinator_file.write_text(
    coordinator_text[:start] + new_method + coordinator_text[end:],
    encoding='utf-8',
)
