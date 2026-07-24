# NeverDie Quest Bot

Discord Bot แบบ Bot-only สำหรับตรวจและดำเนินการกับ Discord Quest ที่รองรับ ไม่มี Desktop/Tauri, CDP launcher, Game Simulator หรือ Quest Tracker แบบกรอก Quest ID

## คำสั่ง

- `/panel` — เปิดแผง One-shot ที่มี `START NOW` และ `STOP ALL`
- `/run` — เริ่ม Auto Daily ตรวจทันทีและตามเวลา 00:00 / 08:00 / 16:00
- `/stop` — เลือกหยุด Auto Daily Runner
- `/api-status` — ดูสถานะฐานข้อมูล Runner และ Quest API; ใช้ได้เฉพาะ Owner/Admin/Manager
- `/ping` และ `/help`

การเริ่ม Runner จำกัดสูงสุด 10 บัญชีต่อผู้ใช้ การนับช่องและเริ่ม Runner ถูกล็อกเป็นชุดเดียวกันเพื่อป้องกันคำสั่งพร้อมกันเปิดเกินจำนวน

## ค่าหลักสำหรับ Deploy

ระบบบังคับให้ตั้ง 6 ค่า:

- `DISCORD_BOT_TOKEN`
- `DISCORD_CLIENT_ID`
- `DISCORD_GUILD_ID`
- `OWNER_ID`
- `RUNNER_TOKEN_SECRET`
- `LOG_WEBHOOK_URL`

ค่าอื่นยัง Override ได้ แต่มีค่าเริ่มต้นอัตโนมัติและไม่บังคับกรอก `LOG_CHANNEL_ID` ยังคงเป็นห้องสำรองสำหรับข้อความสถานะ Runner ส่วน `LOG_WEBHOOK_URL` เป็น Backend emergency log ส่วนตัว

## ความปลอดภัยและข้อมูล

- Auto Daily เก็บ Token แบบเข้ารหัส AES-256-GCM โดยผูกข้อมูลกับ Owner และ Account
- Render/Console logs เก็บ Error ทุกระดับ ส่วน Discord Webhook ส่งเฉพาะเหตุฉุกเฉินของระบบ
- Webhook payload ปิด Mentions และ Redact Token, Secret, Cookie, CAPTCHA, Email และ Webhook URL
- Error ระดับบัญชีเดียวหรือเหตุชั่วคราวไม่ถูกยกระดับเป็น Emergency โดยอัตโนมัติ
- Token, Ciphertext, Username และ Account ID ไม่ถูกพิมพ์ใน Smoke Test log
- HTTP `/api/status` ต้องใช้ Bearer token และจะปิดเมื่อไม่ได้ตั้งค่า
- Slash command `/api-status` จำกัดสิทธิ์ Manager ขึ้นไป
- Database path ถูกเลือกอัตโนมัติ: ใช้ `/var/data/quests.db` เมื่อ Persistent mount พร้อม มิฉะนั้นใช้ `./data/quests.db`
- Database backup เปิดอัตโนมัติสำหรับ Database แบบไฟล์ ใช้ตำแหน่งที่กำหนดตายตัวและเก็บสูงสุด 7 Slot

## การตรวจสอบ

CI ตรวจ Repository shape, Sanitized Quest fixture, ตำแหน่ง Backup ที่อนุญาต, Unit/Regression tests, Syntax ของ `src` และ `scripts` และ Production dependency audit

Manual Quest API smoke เป็นแบบ Read-only: ตรวจบัญชีและอ่านรายการ Quest เท่านั้น ไม่ Enroll, Progress, Heartbeat หรือ Claim การเปลี่ยนข้อมูลจริงต้องตรวจด้วยขั้นตอนควบคุมก่อน Production

## เริ่มใช้งาน

```bash
cd bot
npm ci --ignore-scripts --no-fund --no-audit
npm rebuild better-sqlite3 --foreground-scripts
cp .env.example .env
npm run register
npm start
```

ดูคู่มือติดตั้ง การตั้งค่า Emergency Webhook การสำรองข้อมูล การทดสอบ และ Production checklist ที่ [`bot/README.md`](bot/README.md)

> **คำเตือน:** ระบบที่ใช้ข้อมูลรับรองของบัญชีผู้ใช้เพื่อทำงานอัตโนมัติมีความเสี่ยงด้านบัญชีและข้อกำหนดของแพลตฟอร์ม ผู้ดูแลต้องตรวจสอบกฎปัจจุบันและยอมรับความเสี่ยงก่อนใช้งานจริง

## Runtime hardening

- Runtime SQLite databases, WAL/SHM files and backup files are forbidden in Git and rejected by CI.
- A shared-database runtime lease prevents two Bot processes from running against the same database.
- Production must run exactly one Replica unless every Replica shares the same `DATABASE_PATH`.
- The same Discord account cannot be admitted by different Managers at the same time.
- Each Modal accepts at most 10 Token entries.
- Mutation retry stops when Fresh-state verification itself cannot be completed.
- Stopped Job history remains available per account but is excluded from the active aggregate health state.