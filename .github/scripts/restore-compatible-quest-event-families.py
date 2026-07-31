from pathlib import Path

replacements = {
    Path('bot/src/quest/executors/video-executor.js'): (
        "  return VIDEO_EVENTS.has(eventName);",
        "  return VIDEO_EVENTS.has(eventName) || /^WATCH_VIDEO(?:_|$)/.test(String(eventName ?? ''));",
    ),
    Path('bot/src/quest/executors/desktop-executor.js'): (
        "  return DESKTOP_EVENTS.has(eventName);",
        "  return DESKTOP_EVENTS.has(eventName) || /^PLAY_ON_DESKTOP(?:_V\\d+)?$/.test(String(eventName ?? ''));",
    ),
}

for path, (old, new) in replacements.items():
    source = path.read_text(encoding='utf-8')
    if source.count(old) != 1:
        raise SystemExit(f'{path}: expected one strict matcher, found {source.count(old)}')
    path.write_text(source.replace(old, new, 1), encoding='utf-8')

Path('.github/scripts/restore-compatible-quest-event-families.py').unlink(missing_ok=True)
Path('.github/workflows/restore-compatible-quest-event-families.yml').unlink(missing_ok=True)
