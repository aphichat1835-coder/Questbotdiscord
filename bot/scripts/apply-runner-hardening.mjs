import fs from 'node:fs';

const file = new URL('../src/discord-runner.js', import.meta.url);
let source = fs.readFileSync(file, 'utf8');
let changes = 0;

function replaceOnce(oldText, newText, label) {
  if (!source.includes(oldText)) {
    throw new Error(`Runner hardening anchor not found: ${label}`);
  }
  source = source.replace(oldText, newText);
  changes++;
}

replaceOnce(
  'let live = { ...FALLBACK };',
  `let live = {\n  clientVersion: process.env.DISCORD_CLIENT_VERSION?.trim() || FALLBACK.clientVersion,\n  chromeVersion: process.env.DISCORD_CHROME_VERSION?.trim() || FALLBACK.chromeVersion,\n  electronVersion: process.env.DISCORD_ELECTRON_VERSION?.trim() || FALLBACK.electronVersion,\n  buildNumber: Number.parseInt(process.env.DISCORD_BUILD_NUMBER ?? '', 10) || FALLBACK.buildNumber,\n  nativeBuildNumber: Number.parseInt(process.env.DISCORD_NATIVE_BUILD_NUMBER ?? '', 10) || FALLBACK.nativeBuildNumber,\n};\nconst clientLocale = process.env.DISCORD_LOCALE?.trim() || 'en-US';\nconst clientTimezone = process.env.DISCORD_TIMEZONE?.trim() || config.timezone;`,
  'client profile',
);

const fetchHelpersStart = source.indexOf('function _githubHeaders()');
const dynamicHeadersStart = source.indexOf('// ── Dynamic header builders', fetchHelpersStart);
if (fetchHelpersStart < 0 || dynamicHeadersStart < 0) {
  throw new Error('Runner hardening anchors not found: build-info helpers');
}
source = source.slice(0, fetchHelpersStart) + `/**\n * Keep one coherent client profile for the whole process. Override all related\n * values together through Environment Variables after verifying a Discord update.\n */\nexport async function refreshBuildInfo() {\n  console.log(\n    \`🔄 Client profile — Client: \${live.clientVersion} | Build: \${live.buildNumber} | Chrome: \${live.chromeVersion} | Electron: \${live.electronVersion}\`,\n  );\n  return { ...live, locale: clientLocale, timezone: clientTimezone };\n}\n\n` + source.slice(dynamicHeadersStart);
changes++;

replaceOnce("    system_locale: 'en-US',", '    system_locale: clientLocale,', 'super-properties locale');
replaceOnce("    'X-Discord-Locale': 'en-US',", "    'X-Discord-Locale': clientLocale,", 'Discord locale header');
replaceOnce("    'X-Discord-Timezone': 'Asia/Bangkok',", "    'X-Discord-Timezone': clientTimezone,", 'Discord timezone header');
replaceOnce("    'Accept-Language': 'en-US,en;q=0.9',", "    'Accept-Language': `${clientLocale},en;q=0.9`,", 'accept-language header');

replaceOnce(
`export function getUserJobs(ownerId, { mode = null } = {}) {\n  return [...jobs.entries()]\n    .filter(([, job]) => job.ownerId === ownerId && (!mode || job.mode === mode))\n    .map(([key, job]) => ({ key, ...job.summary() }));\n}`,
`export function getUserJobs(ownerId, { mode = null, includeStopping = false } = {}) {\n  return [...jobs.entries()]\n    .filter(([, job]) => (\n      job.ownerId === ownerId\n      && (!mode || job.mode === mode)\n      && (includeStopping || job.lifecycle !== 'stopping')\n    ))\n    .map(([key, job]) => ({ key, ...job.summary() }));\n}`,
  'getUserJobs lifecycle filter',
);

replaceOnce(
`export function stopJob(ownerId, key, { removeSchedule = true } = {}) {\n  const job = jobs.get(key);\n  if (!job || job.ownerId !== ownerId) return false;\n  job.controller.abort();\n  jobs.delete(key);\n  if (removeSchedule && job.scheduleId != null) {\n    deleteScheduledRunner(job.scheduleId, ownerId);\n  }\n  return true;\n}`,
`export function stopJob(ownerId, key, { removeSchedule = true } = {}) {\n  const job = jobs.get(key);\n  if (!job || job.ownerId !== ownerId) return false;\n  if (job.lifecycle !== 'stopping') {\n    job.lifecycle = 'stopping';\n    job.controller.abort();\n  }\n  if (removeSchedule && job.scheduleId != null) {\n    deleteScheduledRunner(job.scheduleId, ownerId);\n  }\n  return true;\n}`,
  'stopJob lifecycle',
);

replaceOnce(
`  jobs.set(jobKey, {\n    ownerId,\n    accountId,\n    mode,\n    scheduleId,\n    controller,\n    summary: () => ({\n      username,\n      accountId,\n      mode,\n      scheduleId,\n      nextCheckAt,\n      status: logLines.at(-1) ?? '',\n    }),\n  });`,
`  const jobRecord = {\n    ownerId,\n    accountId,\n    mode,\n    scheduleId,\n    controller,\n    lifecycle: 'running',\n    done: null,\n    summary: () => ({\n      username,\n      accountId,\n      mode,\n      scheduleId,\n      lifecycle: jobRecord.lifecycle,\n      nextCheckAt,\n      status: logLines.at(-1) ?? '',\n    }),\n  };\n  jobs.set(jobKey, jobRecord);`,
  'job record lifecycle',
);

if (changes !== 9) throw new Error(`Expected 9 runner hardening changes, got ${changes}`);
fs.writeFileSync(file, source);
console.log(`Applied ${changes} runner hardening changes`);
