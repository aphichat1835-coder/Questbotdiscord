import { discordRateLimitCoordinator } from './rate-limit-coordinator.js';

export const DISCORD_API_VERSION = 10;
export const DISCORD_API_BASE = `https://discord.com/api/v${DISCORD_API_VERSION}`;

let installed = false;
let originalFetch = null;

function isDiscordApiUrl(url) {
  return url.origin === 'https://discord.com' && /^\/api\/v\d+(?:\/|$)/.test(url.pathname);
}

function rewriteDiscordApiUrl(input) {
  const source = input instanceof Request ? input.url : String(input);
  const url = new URL(source);
  if (!isDiscordApiUrl(url)) return { input, url: source, coordinated: false };
  url.pathname = url.pathname.replace(
    /^\/api\/v\d+/,
    `/api/v${DISCORD_API_VERSION}`,
  );
  const rewritten = url.toString();
  if (input instanceof Request) {
    return { input: new Request(rewritten, input), url: rewritten, coordinated: true };
  }
  return { input: rewritten, url: rewritten, coordinated: true };
}

export function installDiscordApiRuntime({ fetchFn = globalThis.fetch } = {}) {
  if (installed) return false;
  if (typeof fetchFn !== 'function') throw new TypeError('Global fetch is unavailable');

  originalFetch = fetchFn.bind(globalThis);
  globalThis.fetch = (input, options = {}) => {
    const rewritten = rewriteDiscordApiUrl(input);
    if (!rewritten.coordinated) return originalFetch(input, options);
    const requestOptions = input instanceof Request
      ? { ...Object.fromEntries(input.headers), ...options }
      : options;
    return discordRateLimitCoordinator.schedule(
      rewritten.url,
      {
        ...options,
        headers: options.headers ?? (input instanceof Request ? input.headers : undefined),
      },
      () => originalFetch(rewritten.input, requestOptions),
    );
  };
  installed = true;
  return true;
}

export function uninstallDiscordApiRuntime() {
  if (!installed || !originalFetch) return false;
  globalThis.fetch = originalFetch;
  installed = false;
  originalFetch = null;
  return true;
}

export function getDiscordApiRuntimeStatus() {
  return {
    installed,
    apiVersion: DISCORD_API_VERSION,
    apiBase: DISCORD_API_BASE,
    rateLimit: discordRateLimitCoordinator.snapshot(),
  };
}
