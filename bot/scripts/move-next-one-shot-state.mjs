import fs from 'node:fs';

const file = new URL('../src/discord-runner.js', import.meta.url);
let source = fs.readFileSync(file, 'utf8');

const runnerAnchor = `// ── Runner ────────────────────────────────────────────────────────────────────\n\nexport async function startRunner({`;
const outerHelper = `// ── Runner ────────────────────────────────────────────────────────────────────\n\nfunction nextOneShotState(noProgressRounds, outcome) {\n  if (outcome.supportedCount === 0) return { stop: true, noProgressRounds };\n  const nextRounds = outcome.progressed ? 0 : noProgressRounds + 1;\n  return { stop: nextRounds >= 3, noProgressRounds: nextRounds };\n}\n\nexport async function startRunner({`;
const nestedHelper = `  function nextOneShotState(noProgressRounds, outcome) {\n    if (outcome.supportedCount === 0) return { stop: true, noProgressRounds };\n    const nextRounds = outcome.progressed ? 0 : noProgressRounds + 1;\n    return { stop: nextRounds >= 3, noProgressRounds: nextRounds };\n  }\n\n`;

if (!source.includes(runnerAnchor)) throw new Error('Runner anchor not found');
if (!source.includes(nestedHelper)) throw new Error('Nested helper anchor not found');
if (source.includes('function nextOneShotState(noProgressRounds, outcome) {\n  if (outcome.supportedCount')) {
  throw new Error('Outer helper already exists');
}

source = source.replace(runnerAnchor, outerHelper);
source = source.replace(nestedHelper, '');

const occurrences = source.match(/function nextOneShotState\(/g) ?? [];
if (occurrences.length !== 1) {
  throw new Error(`Expected exactly one nextOneShotState declaration, found ${occurrences.length}`);
}

fs.writeFileSync(file, source);
console.log('Moved nextOneShotState to module scope');
