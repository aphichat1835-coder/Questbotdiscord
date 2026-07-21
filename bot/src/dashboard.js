import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { config } from './config.js';
import { getQuestEngineStatus, listJobs } from './discord-runner.js';
import { listScheduledRunners } from './scheduled-runner-store.js';
import { reportCriticalError } from './error-reporter.js';

const PORT = Number.parseInt(process.env.PORT ?? '3000', 10) || 3000;
let botClient = null;
let server = null;
const startedAt = Date.now();

export function startDashboard(client) {
  if (client) botClient = client;
  if (server) return;

  server = createServer(handleRequest);
  server.on('error', (error) => {
    void reportCriticalError('Health server', error);
  });
  server.listen(PORT, () => {
    console.log(`🌐 Health server ready → port ${PORT}`);
  });
}

export async function stopDashboard() {
  if (!server) return;
  const activeServer = server;
  server = null;
  await new Promise((resolve) => activeServer.close(resolve));
}

export function detailedStatusPayload() {
  const jobs = listJobs();
  const quest = getQuestEngineStatus();
  return {
    ok: botClient?.isReady() ?? false,
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    pingMs: botClient?.ws?.ping ?? -1,
    runners: {
      active: jobs.length,
      oneShot: jobs.filter((job) => job.mode === 'oneshot').length,
      autoDaily: jobs.filter((job) => job.mode === 'scheduled').length,
      persisted: listScheduledRunners().length,
    },
    questApi: {
      state: quest.state,
      lastSuccessfulCheckAt: quest.lastSuccessfulCheckAt,
    },
  };
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

export function hasStatusAccess(authorization, expected = config.healthStatusToken) {
  if (!expected || typeof authorization !== 'string') return false;
  if (!authorization.startsWith('Bearer ')) return false;
  const supplied = authorization.slice(7);
  const expectedBuffer = Buffer.from(expected);
  const suppliedBuffer = Buffer.from(supplied);
  return expectedBuffer.length === suppliedBuffer.length
    && timingSafeEqual(expectedBuffer, suppliedBuffer);
}

function handleRequest(req, res) {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/healthz') {
    const ok = botClient?.isReady() ?? false;
    return sendJson(res, ok ? 200 : 503, { ok });
  }

  if (pathname === '/api/status') {
    if (!config.healthStatusToken) return sendJson(res, 404, { error: 'not_found' });
    if (!hasStatusAccess(req.headers.authorization)) {
      return sendJson(res, 401, { error: 'unauthorized' });
    }
    const payload = detailedStatusPayload();
    return sendJson(res, payload.ok ? 200 : 503, payload);
  }

  return sendJson(res, 404, { error: 'not_found' });
}
