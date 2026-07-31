from pathlib import Path

replacements = {
    Path('bot/src/quest/executors/video-executor.js'): (
        "  return VIDEO_EVENTS.has(eventName) || /^WATCH_VIDEO(?:_|$)/.test(String(eventName ?? ''));",
        "  return VIDEO_EVENTS.has(eventName);",
    ),
    Path('bot/src/quest/executors/desktop-executor.js'): (
        "  return DESKTOP_EVENTS.has(eventName) || /^PLAY_ON_DESKTOP(?:_V\\d+)?$/.test(String(eventName ?? ''));",
        "  return DESKTOP_EVENTS.has(eventName);",
    ),
}

for path, (old, new) in replacements.items():
    source = path.read_text(encoding='utf-8')
    if source.count(old) != 1:
        raise SystemExit(f'{path}: expected one match, found {source.count(old)}')
    path.write_text(source.replace(old, new, 1), encoding='utf-8')

Path('.github/scripts/apply-quest-executor-allowlist.py').unlink(missing_ok=True)
Path('.github/workflows/apply-quest-executor-allowlist.yml').unlink(missing_ok=True)
