import fs from 'node:fs';

const { GH_TOKEN, REPOSITORY, TARGET_SHA } = process.env;
if (!GH_TOKEN || !REPOSITORY || !TARGET_SHA) throw new Error('Missing inspector environment');

const headers = {
  Authorization: `Bearer ${GH_TOKEN}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readJson(url) {
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`GitHub API ${response.status}: ${url}`);
  return response.json();
}

const checksUrl = `https://api.github.com/repos/${REPOSITORY}/commits/${TARGET_SHA}/check-runs?per_page=100`;
let runs = [];
for (let attempt = 1; attempt <= 24; attempt++) {
  const payload = await readJson(checksUrl);
  runs = payload.check_runs ?? [];
  const relevant = runs.filter((run) => /codacy|sonar/i.test(run.name));
  if (relevant.length >= 2 && relevant.every((run) => run.status === 'completed')) break;
  if (attempt < 24) await delay(15_000);
}

const evidence = [];
for (const run of runs.filter((item) => /codacy|sonar/i.test(item.name))) {
  const annotations = await readJson(
    `https://api.github.com/repos/${REPOSITORY}/check-runs/${run.id}/annotations?per_page=100`,
  );
  evidence.push({
    id: run.id,
    name: run.name,
    status: run.status,
    conclusion: run.conclusion,
    detailsUrl: run.details_url,
    title: run.output?.title,
    summary: run.output?.summary,
    text: run.output?.text,
    annotations: annotations.map((item) => ({
      path: item.path,
      startLine: item.start_line,
      endLine: item.end_line,
      level: item.annotation_level,
      title: item.title,
      message: item.message,
    })),
  });
}

fs.writeFileSync('target-check-evidence.json', `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify(evidence, null, 2));
if (evidence.length < 2) process.exitCode = 2;
