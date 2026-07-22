# NeverDie Quest Bot

Discord Bot แบบ Bot-only สำหรับตรวจและดำเนินการกับ Discord Quest ที่รองรับ ไม่มี Desktop/Tauri, CDP launcher, Game Simulator หรือ Quest Tracker แบบกรอก Quest ID

## คำสั่ง

- `/panel` — เปิดแผง One-shot ที่มี `START NOW` และ `STOP ALL`
- `/run` — เริ่ม Auto Daily ตรวจทันทีและตามเวลา 00:00 / 08:00 / 16:00
- `/stop` — เลือกหยุด Auto Daily Runner
- `/api-status` — ดูสถานะฐานข้อมูล Runner และ Quest API; ใช้ได้เฉพาะ Owner/Admin/Manager
- `/ping` และ `/help`

การเริ่ม Runner จำกัดสูงสุด 10 บัญชีต่อผู้ใช้ การนับช่องและเริ่ม Runner ถูกล็อกเป็นชุดเดียวกันเพื่อป้องกันคำสั่งพร้อมกันเปิดเกินจำนวน

## ความปลอดภัยและข้อมูล

- Auto Daily เก็บ Token แบบเข้ารหัส AES-256-GCM โดยผูกข้อมูลกับ Owner และ Account
- Token, Ciphertext, Username และ Account ID ไม่ถูกพิมพ์ใน Smoke Test log
- HTTP `/api/status` ต้องใช้ Bearer token และจะปิดเมื่อไม่ได้ตั้งค่า
- Slash command `/api-status` จำกัดสิทธิ์ Manager ขึ้นไป
- Database backup ใช้ตำแหน่งที่กำหนดตายตัวและเก็บสูงสุด 7 Slot
- เมื่อ `DATABASE_PATH` อยู่ใต้ `/var/data/` Backup จะอยู่ใน `/var/data/backups` เพื่อใช้ Persistent Volume เดียวกัน

## การตรวจสอบ

CI ตรวจ Repository shape, Sanitized Quest fixture, ตำแหน่ง Backup ที่อนุญาต, Unit/Regression tests, Syntax ของ `src` และ `scripts` และ Production dependency audit

Manual Quest API smoke เป็นแบบ Read-only: ตรวจบัญชีและอ่านรายการ Quest เท่านั้น ไม่ Enroll, Progress, Heartbeat หรือ Claim การเปลี่ยนข้อมูลจริงต้องตรวจด้วยขั้นตอนควบคุมก่อน Production

## เริ่มใช้งาน

```bash
cd bot
npm ci
cp .env.example .env
npm run register
npm start
```

ดูคู่มือติดตั้ง การตั้งค่า การสำรองข้อมูล การทดสอบ และ Production checklist ที่ [`bot/README.md`](bot/README.md)

> **คำเตือน:** ระบบที่ใช้ข้อมูลรับรองของบัญชีผู้ใช้เพื่อทำงานอัตโนมัติมีความเสี่ยงด้านบัญชีและข้อกำหนดของแพลตฟอร์ม ผู้ดูแลต้องตรวจสอบกฎปัจจุบันและยอมรับความเสี่ยงก่อนใช้งานจริง
