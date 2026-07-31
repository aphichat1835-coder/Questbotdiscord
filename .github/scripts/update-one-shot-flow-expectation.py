from pathlib import Path

path = Path('bot/test/runner-modes.node-test.js')
source = path.read_text(encoding='utf-8')
old = "    '🎉 บอทได้เข้าไปทำ Quest ทั้งหมดเสร็จสิ้นทั้งหมดแล้ว',"
new = "    '🎉 บอทได้เข้าไปทำ Quest และรับรางวัลทั้งหมดเสร็จสิ้นแล้ว',"

if source.count(old) != 1:
    raise SystemExit(f'expected exactly one legacy success expectation, found {source.count(old)}')

path.write_text(source.replace(old, new, 1), encoding='utf-8')

Path('.github/scripts/update-one-shot-flow-expectation.py').unlink(missing_ok=True)
Path('.github/workflows/update-one-shot-flow-expectation.yml').unlink(missing_ok=True)
