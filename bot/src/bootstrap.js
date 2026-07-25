import { INCIDENT } from './incident-catalog.js';
import { reportBootstrapIncident } from './bootstrap-reporter.js';

export const FATAL_REPORT_BUDGET_MS = 3500;
let fatalBootstrapPromise = null;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function reportWithinFatalBudget(reportPromise, budgetMs = FATAL_REPORT_BUDGET_MS) {
  return Promise.race([
    Promise.resolve(reportPromise),
    delay(budgetMs).then(() => ({ state: 'budget_expired' })),
  ]);
}

export async function fatalBootstrapShutdown({
  code = INCIDENT.CLIENT_STARTUP_FAILED,
  error,
  context = {},
} = {}) {
  if (fatalBootstrapPromise) return fatalBootstrapPromise;
  fatalBootstrapPromise = reportWithinFatalBudget(
    reportBootstrapIncident({ code, error, context }),
  ).catch(() => ({ state: 'report_failed' }));
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
