const { GH_TOKEN, REPOSITORY, HEAD_SHA } = process.env;
if (!GH_TOKEN || !REPOSITORY || !HEAD_SHA) {
  throw new Error('GH_TOKEN, REPOSITORY and HEAD_SHA are required');
}

const headers = {
  Authorization: `Bearer ${GH_TOKEN}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readJson(url) {
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`GitHub API ${response.status} for ${url}`);
  return response.json();
}

const checksUrl = `https://api.github.com/repos/${REPOSITORY}/commits/${HEAD_SHA}/check-runs?per_page=100`;
let sonarRuns = [];
for (let attempt = 1; attempt <= 24; attempt++) {
  const payload = await readJson(checksUrl);
  sonarRuns = (payload.check_runs ?? []).filter((run) => /sonar/i.test(run.name));
  if (sonarRuns.some((run) => run.status === 'completed')) break;
  if (attempt < 24) await delay(15_000);
}

if (!sonarRuns.length) {
  console.log('No Sonar check run was visible to the read-only token.');
  process.exitCode = 2;
} else {
  for (const run of sonarRuns) {
    console.log(JSON.stringify({
      id: run.id,
      name: run.name,
      status: run.status,
      conclusion: run.conclusion,
      detailsUrl: run.details_url,
      title: run.output?.title,
      summary: run.output?.summary,
      text: run.output?.text,
    }, null, 2));

    const annotations = await readJson(
      `https://api.github.com/repos/${REPOSITORY}/check-runs/${run.id}/annotations?per_page=100`,
    );
    console.log(JSON.stringify(annotations.map(({
      path,
      start_line: startLine,
      end_line: endLine,
      annotation_level: annotationLevel,
      title,
      message,
      raw_details: rawDetails,
    }) => ({
      path,
      startLine,
      endLine,
      annotationLevel,
      title,
      message,
      rawDetails,
    })), null, 2));
  }
}
