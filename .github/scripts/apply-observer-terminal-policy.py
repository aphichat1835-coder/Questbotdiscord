from pathlib import Path

path = Path('bot/src/quest/runner-state-observer.js')
source = path.read_text(encoding='utf-8')
old = "  if (/TOKEN INVALID|ERROR|ไม่สำเร็จ/.test(status)) return RUNNER_STATE.FAILED;"
new = "  if (/TOKEN INVALID/.test(status)) return RUNNER_STATE.FAILED;"

if source.count(old) != 1:
    raise SystemExit(f'expected exactly one terminal text policy, found {source.count(old)}')

path.write_text(source.replace(old, new, 1), encoding='utf-8')
Path('.github/scripts/apply-observer-terminal-policy.py').unlink(missing_ok=True)
Path('.github/workflows/apply-observer-terminal-policy.yml').unlink(missing_ok=True)
