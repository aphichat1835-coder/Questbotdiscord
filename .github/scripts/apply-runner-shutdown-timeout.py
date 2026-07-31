from pathlib import Path

path = Path('bot/src/quest/runner-service.js')
source = path.read_text(encoding='utf-8')
old = 'export async function shutdownRunners(timeoutMs = null) {'
new = '''export const DEFAULT_RUNNER_SHUTDOWN_TIMEOUT_MS = 15_000;

export async function shutdownRunners(timeoutMs = DEFAULT_RUNNER_SHUTDOWN_TIMEOUT_MS) {'''

if source.count(old) != 1:
    raise SystemExit(f'expected exactly one shutdown signature, found {source.count(old)}')

path.write_text(source.replace(old, new, 1), encoding='utf-8')
Path('.github/scripts/apply-runner-shutdown-timeout.py').unlink(missing_ok=True)
Path('.github/workflows/apply-runner-shutdown-timeout.yml').unlink(missing_ok=True)
