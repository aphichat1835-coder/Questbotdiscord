#!/usr/bin/env python3
from pathlib import Path
import subprocess


def replace_once(path: str, old: str, new: str, label: str) -> None:
    file = Path(path)
    source = file.read_text(encoding='utf-8')
    count = source.count(old)
    if count != 1:
        raise SystemExit(f'{path} [{label}]: expected exactly one target, found {count}')
    file.write_text(source.replace(old, new, 1), encoding='utf-8')
    print(f'patched {label}')


def insert_after(path: str, marker: str, insertion: str, label: str) -> None:
    replace_once(path, marker, marker + insertion, label)


replace_once(
    'src/worker.js',
    """  } catch (error) {
    if (backupHealth.recoveryPending) {
      backupHealth.recoveryPending = false;
      backupHealth.incidentOpen = false;
    }
    backupHealth.state = 'degraded';""",
    """  } catch (error) {
    backupHealth.state = 'degraded';""",
    'backup recovery state preservation',
)
replace_once(
    'src/discord-runner.js',
    """import { verifyRunnerMutationFromQuests } from './quest/durable-mutation-verifier.js';
import {
  getRunnerState,""",
    """import { verifyRunnerMutationFromQuests } from './quest/durable-mutation-verifier.js';
import { fetchDurableRecoveryQuests } from './quest/recovery-fetch.js';
import {
  getRunnerState,""",
    'recovery fetch import',
)
replace_once(
    'src/discord-runner.js',
    """    const quests = await fetchQuests(userToken, signal);
    if (recoveryPlan.action === 'VERIFY_MUTATION') {""",
    """    const quests = await fetchDurableRecoveryQuests({
      fetchQuests,
      userToken,
      signal,
      isFatalAuthError,
      onDeferred: async () => {
        addLog(`⚠️ ${username}: RECOVERY DEFERRED — RETRY IN NORMAL LOOP`);
        await render();
      },
    });
    if (!quests) return;
    if (recoveryPlan.action === 'VERIFY_MUTATION') {""",
    'recovery fetch deferral',
)
replace_once(
    'src/bootstrap.js',
    """import { reportBootstrapIncident } from './bootstrap-reporter.js';

export const FATAL_REPORT_BUDGET_MS = 3500;""",
    """import { reportBootstrapIncident } from './bootstrap-reporter.js';
import { redactText } from './redaction.js';

export const FATAL_REPORT_BUDGET_MS = 3500;""",
    'bootstrap redaction import',
)
replace_once(
    'src/bootstrap.js',
    """} = {}) {
  if (fatalBootstrapPromise) return fatalBootstrapPromise;
  const report = reportBootstrapIncident({ code, error, context })""",
    """} = {}) {
  if (fatalBootstrapPromise) {
    let serializedContext;
    try {
      serializedContext = JSON.stringify(context);
    } catch {
      serializedContext = String(context);
    }
    console.error(
      `❌ [Bootstrap ${code} suppressed - fatal shutdown already in progress]`,
      redactText(error?.stack || error?.message || error),
      redactText(serializedContext, { fallback: '{}' }),
    );
    return fatalBootstrapPromise;
  }
  const report = reportBootstrapIncident({ code, error, context })""",
    'repeated bootstrap fatal evidence',
)
replace_once(
    'src/quest/runner-state-store.js',
    """function classifyCodeRunnerError(error) {
  const code = String(error?.code ?? '');
  if (code.startsWith('SQLITE_')) return RUNNER_ERROR_CATEGORY.STORAGE;
  if (NETWORK_ERROR_CODES.has(code)) return RUNNER_ERROR_CATEGORY.NETWORK;
  return null;
}""",
    """function classifyCodeRunnerError(error) {
  for (const rawCode of [error?.code, error?.cause?.code]) {
    const code = String(rawCode ?? '');
    if (code.startsWith('SQLITE_')) return RUNNER_ERROR_CATEGORY.STORAGE;
    if (NETWORK_ERROR_CODES.has(code) || code.startsWith('UND_ERR_')) {
      return RUNNER_ERROR_CATEGORY.NETWORK;
    }
  }
  return null;
}""",
    'network error evidence',
)
replace_once(
    'src/quest/runner-state-store.js',
    """  if (category) return category;
  if (!Number.isInteger(error?.status) && error instanceof Error) {
    return RUNNER_ERROR_CATEGORY.NETWORK;
  }
  return RUNNER_ERROR_CATEGORY.UNKNOWN;""",
    """  if (category) return category;
  if (error?.message === 'fetch failed') return RUNNER_ERROR_CATEGORY.NETWORK;
  return RUNNER_ERROR_CATEGORY.UNKNOWN;""",
    'generic error classification',
)

embed_helper = """function fitIncidentEmbedText(title, details, fields, footerText) {
  const boundedFields = fields.map((field) => ({ ...field }));
  const fixedLength = () => title.length + footerText.length + boundedFields.reduce(
    (total, field) => total + field.name.length + field.value.length,
    0,
  );
  let overflow = Math.max(0, fixedLength() + 8 - 6000);
  for (let index = boundedFields.length - 1; index >= 0 && overflow > 0; index--) {
    const removable = Math.max(0, boundedFields[index].value.length - 1);
    const removed = Math.min(removable, overflow);
    if (removed > 0) {
      boundedFields[index].value = boundedFields[index].value.slice(0, -removed);
      overflow -= removed;
    }
  }
  const descriptionBudget = Math.max(8, Math.min(4096, 6000 - fixedLength()));
  return {
    fields: boundedFields,
    description: codeBlock(details, Math.max(0, descriptionBudget - 8)),
  };
}

"""
replace_once(
    'src/error-reporter.js',
    'export function buildIncidentWebhookPayload({',
    embed_helper + 'export function buildIncidentWebhookPayload({',
    'incident embed budget helper',
)
insert_after(
    'src/error-reporter.js',
    "    : [safeErrorMessage(error), safeErrorStack(error)].filter(Boolean).join('\\n');",
    """
  const title = `${status === 'RECOVERED' ? '✅' : '🚨'} ${definition.title}`;
  const footerText = 'NeverDie Quest Bot · Backend Incident Log';
  const fitted = fitIncidentEmbedText(
    title,
    details,
    incidentFields({ code, incidentId, status, context, occurrences }),
    footerText,
  );""",
    'incident fitted values',
)
replace_once('src/error-reporter.js', "title: `${status === 'RECOVERED' ? '✅' : '🚨'} ${definition.title}`,", 'title,', 'incident fitted title')
replace_once('src/error-reporter.js', 'description: codeBlock(details, 2200),', 'description: fitted.description,', 'incident fitted description')
replace_once('src/error-reporter.js', 'fields: incidentFields({ code, incidentId, status, context, occurrences }),', 'fields: fitted.fields,', 'incident fitted fields')
replace_once('src/error-reporter.js', "footer: { text: 'NeverDie Quest Bot · Backend Incident Log' },", 'footer: { text: footerText },', 'incident fitted footer')
replace_once(
    'src/error-reporter.js',
    """  incident.occurrences++;
  incident.lastSeenAt = now;
  reporterStatus.suppressedIncidents++;""",
    """  incident.occurrences++;
  incident.lastSeenAt = now;
  if (incident.state === 'recovering') incident.reoccurredDuringRecovery = true;
  reporterStatus.suppressedIncidents++;""",
    'recovery recurrence marker',
)
replace_once(
    'src/error-reporter.js',
    """    nextRetryAt: null,
    state: 'new',""",
    """    nextRetryAt: null,
    reoccurredDuringRecovery: false,
    state: 'new',""",
    'new incident recurrence state',
)
replace_once(
    'src/error-reporter.js',
    """  if (!incident || incident.state === 'recovered') return { state: 'not_open', code };
  if (incident.state === 'delivering') {""",
    """  if (!incident || incident.state === 'recovered') return { state: 'not_open', code };
  if (['delivery_failed', 'delivery_unknown'].includes(incident.state)) {
    incident.state = 'recovered';
    incident.recoveredAt = now;
    incidentState.set(key, incident);
    pruneReporterState(now);
    return { state: 'not_open', code, incidentId: incident.incidentId };
  }
  if (incident.state === 'delivering') {""",
    'silent recovery for undelivered incident',
)
replace_once(
    'src/error-reporter.js',
    """  incident.recoveryDelivery = delivery;
  if (delivery.state === 'delivered') {
    incident.recoveredAt = now;
    incident.state = 'recovered';
    incident.nextRecoveryRetryAt = null;
  } else {
    incident.state = 'recovery_pending';
    incident.nextRecoveryRetryAt = now + FAILED_DELIVERY_RETRY_MS;
  }
  incidentState.set(key, incident);
  pruneReporterState(now);

  recordDeliveryStatus(code, incident.incidentId, delivery, now);
  return { state: delivery.state, code, incidentId: incident.incidentId };""",
    """  incident.recoveryDelivery = delivery;
  let resultState = delivery.state;
  if (incident.reoccurredDuringRecovery) {
    incident.reoccurredDuringRecovery = false;
    incident.recoveredAt = null;
    incident.state = 'open';
    incident.nextRecoveryRetryAt = null;
    resultState = 'reopened';
  } else if (delivery.state === 'delivered') {
    incident.recoveredAt = now;
    incident.state = 'recovered';
    incident.nextRecoveryRetryAt = null;
  } else {
    incident.state = 'recovery_pending';
    incident.nextRecoveryRetryAt = now + FAILED_DELIVERY_RETRY_MS;
  }
  incidentState.set(key, incident);
  pruneReporterState(now);

  recordDeliveryStatus(code, incident.incidentId, delivery, now);
  return { state: resultState, code, incidentId: incident.incidentId };""",
    'recovery recurrence finalization',
)
replace_once(
    'test/backup-health.node-test.js',
    """test('a new failure after pending recovery starts a fresh incident lifecycle', async () => {
  resetBackupHealthForTests({
    state: 'healthy',
    consecutiveFailures: 0,
    incidentOpen: true,
    recoveryPending: true,
  });
  const spies = reportingSpies();

  await runBackupAttempt({
    now: new Date('2026-07-25T13:00:00.000Z'),
    backupFn: async () => { throw new Error('backup failed again'); },
    ...spies,
  });

  const status = getBackupHealthStatus();
  assert.equal(status.recoveryPending, false);
  assert.equal(status.incidentOpen, false);
  assert.equal(spies.incidents.length, 0);
});""",
    """test('a new failure preserves pending recovery so a later success can close the reporter incident', async () => {
  resetBackupHealthForTests({
    state: 'healthy',
    consecutiveFailures: 0,
    incidentOpen: true,
    recoveryPending: true,
  });
  const spies = reportingSpies();

  const failed = await runBackupAttempt({
    now: new Date('2026-07-25T13:00:00.000Z'),
    backupFn: async () => { throw new Error('backup failed again'); },
    ...spies,
  });
  const pending = getBackupHealthStatus();
  const recovered = await runBackupAttempt({
    now: new Date('2026-07-25T13:15:00.000Z'),
    backupFn: async () => './data/backups/questbot-slot-1.db',
    ...spies,
  });

  assert.equal(failed.ok, false);
  assert.equal(pending.recoveryPending, true);
  assert.equal(pending.incidentOpen, true);
  assert.equal(spies.incidents.length, 0);
  assert.equal(recovered.recovery.state, 'delivered');
  assert.equal(spies.recoveries.length, 1);
  assert.equal(getBackupHealthStatus().recoveryPending, false);
  assert.equal(getBackupHealthStatus().incidentOpen, false);
});""",
    'backup pending recovery test',
)
subprocess.run(['git', 'add', 'test/backup-health.node-test.js'], check=True)
print('Applied second-pass full-audit replacements')
