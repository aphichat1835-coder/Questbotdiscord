import { INCIDENT } from './incident-catalog.js';
import { reportBootstrapIncident } from './bootstrap-reporter.js';

export const FATAL_REPORT_BUDGET_MS = 3500;
let fatalBootstrapPromise = null;

export async function reportWithinFatalBudget(
  reportPromise,
  budgetMs = FATAL_REPORT_BUDGET_MS,
  { unrefTimer = process.env.NODE_TEST_WORKER_ID == null } = {},
) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ state: 'budget_expired' }), budgetMs);
    if (unrefTimer) timer.unref?.();
  });
  try {
    return await Promise.race([Promise.resolve(reportPromise), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function fatalBootstrapShutdown({
  code = INCIDENT.CLIENT_STARTUP_FAILED,
  error,
  context = {},
} = {}) {
  if (fatalBootstrapPromise) return fatalBootstrapPromise;
  const report = reportBootstrapIncident({ code, error, context })
    .catch(() => ({ state: 'report_failed' }));
  fatalBootstrapPromise = reportWithinFatalBudget(report);
  const result = await fatalBootstrapPromise;
  process.exitCode = 1;
  return result;
}

export function installBootstrapProcessHandlers({ exit = process.exit } = {}) {
  const onUnhandledRejection = (reason) => {
    void fatalBootstrapShutdown({
      code: INCIDENT.UNHANDLED_REJECTION,
      error: reason,
      context: { component: 'bootstrap' },
    }).finally(() => exit(1));
  };
  const onUncaughtException = (error) => {
    void fatalBootstrapShutdown({
      code: INCIDENT.UNCAUGHT_EXCEPTION,
      error,
      context: { component: 'bootstrap' },
    }).finally(() => exit(1));
  };

  process.on('unhandledRejection', onUnhandledRejection);
  process.on('uncaughtException', onUncaughtException);
  return () => {
    process.off('unhandledRejection', onUnhandledRejection);
    process.off('uncaughtException', onUncaughtException);
  };
}

export function resetBootstrapStateForTests() {
  fatalBootstrapPromise = null;
}
