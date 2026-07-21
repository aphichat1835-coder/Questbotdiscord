# NeverDie Quest Bot

Discord Bot สำหรับตรวจและทำ Discord Quest ที่รองรับแบบอัตโนมัติ

## คำสั่ง

- `/panel` — เปิดแผง One-shot ที่มีเฉพาะ `START NOW` และ `STOP ALL`
- `/run` — เปิด Auto Daily ตรวจทันทีและตามเวลา 00:00 / 08:00 / 16:00
- `/stop` — เลือกหยุด Auto Daily Runner
- `/api-status` — ดูฐานข้อมูล Runner และผลตรวจ Quest API ล่าสุด
- `/ping` และ `/help`

Repository นี้เป็น **Bot-only** ระบบ Desktop/Tauri, CDP, Game Simulator และ Quest Tracker แบบ Quest ID ถูกถอดออกแล้ว

## เริ่มใช้งาน

```bash
cd bot
npm ci
cp .env.example .env
npm run register
npm start
```

ดูรายละเอียดที่ [`bot/README.md`](bot/README.md)
