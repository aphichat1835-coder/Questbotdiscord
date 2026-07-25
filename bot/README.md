# NeverDie Quest Bot — คู่มือระบบปัจจุบัน

ระบบนี้เป็น Discord Bot แบบ Bot-only สำหรับตรวจและดำเนินการกับ Discord Quest ที่รองรับ ไม่มี Desktop/Tauri, CDP launcher, Game Simulator หรือ Quest Tracker แบบกรอก Quest ID

## ติดตั้ง

ต้องใช้ Node.js ตาม `.node-version` และ `package.json`

```bash
npm ci --ignore-scripts --no-fund --no-audit
npm rebuild better-sqlite3 --foreground-scripts
cp .env.example .env
npm run register
npm start
```

หลังแก้ Slash command ให้รัน `npm run register` ใหม่

## Environment

### ค่าหลักที่จำเป็น 6 ค่า

- `DISCORD_BOT_TOKEN` — Token ของ Bot
- `DISCORD_CLIENT_ID` — Application/Client ID
- `DISCORD_GUILD_ID` — Server ที่ลงทะเบียนคำสั่ง
- `OWNER_ID` — Discord User ID ของเจ้าของระบบ
- `RUNNER_TOKEN_SECRET` — Secret ยาวอย่างน้อย 16 ตัวอักษรสำหรับเข้ารหัส Token ของ Auto Daily
- `LOG_WEBHOOK_URL` — Discord Incoming Webhook ส่วนตัวสำหรับ Backend incident log

หากค่าหลักขาดหรือรูปแบบไม่ถูกต้อง Bot จะหยุดตั้งแต่ Startup โดยไม่เริ่มระบบแบบตั้งค่าครึ่งเดียว

### Optional overrides

- `MANAGER_ROLE_ID` — Role ที่ใช้ Start/Stop Runner และดู `/api-status`; Owner/Admin ใช้ได้เสมอ
- `TIMEZONE` — ค่าเริ่มต้น `Asia/Bangkok`
- `LOG_CHANNEL_ID` — ห้องสำรองสำหรับข้อความสถานะ Runner เดิม ไม่ใช่ Incident Webhook
- `DATABASE_PATH`, `DATABASE_BACKUP_ENABLED`, `DATABASE_BACKUP_RETENTION`
- `HEALTH_STATUS_TOKEN` — เปิด HTTP `GET /api/status`
- `PORT` — Render กำหนดให้อัตโนมัติ ปกติไม่ต้องตั้ง
- Discord client profile overrides ต้องเปลี่ยนพร้อมกันทั้งชุดและ Restart

## Safe bootstrap

`index.js` ติดตั้ง Process handlers ก่อน Dynamic import ของ Runtime modules ทำให้ Config, Database และ Module import failure ยังสามารถส่ง Bootstrap incident โดยไม่พึ่ง SQLite หรือ Discord Client

Startup ทำตามลำดับ:

1. ติดตั้ง Bootstrap handlers
2. โหลด Runtime modules
3. เปิดฐานข้อมูลและทำ Migration
4. Acquire runtime lease
5. Bind Health server และรอ `listening`
6. โหลด Discord client profile
7. Login Discord
8. Start worker และ Restore Scheduled Runner

Health server bind failure ทำให้ Startup ล้มทันที ไม่ปล่อย Bot ทำงานแบบครึ่งระบบ Fatal report มี Budget รวม 3.5 วินาทีก่อน Shutdown

## Backend Incident Webhook

Render/Console logs บันทึก Error ทุกระดับ ส่วน Webhook รับเฉพาะ Structured Incident:

- Incident มี Code, Incident ID, Impact, Action, Runtime และ Deployment
- Context ใช้ Allowlist ต่อ Code
- ปิด Mentions และ Redirect
- HTTP 429/502/503/504 Retry ได้สูงสุดหนึ่งครั้ง
- Network timeout หลังเริ่ม POST เป็น `delivery_unknown` และไม่ส่งซ้ำแบบเดาสุ่ม
- เหตุซ้ำรวมด้วย `code + scope` ภายใน 10 นาที
- Recovery ใช้ Incident ID เดิม
- Webhook ล้มไม่ทำให้ Bot ดับ

### แจ้งทันที

- Database เปิดไม่ได้หรือ Migration ล้ม
- Runtime lease conflict/lost
- Health server bind failure
- Discord login/session failure
- Uncaught exception / Unhandled rejection
- Quest schema/parser break

### แจ้งเมื่อผ่าน Threshold

- Backup ล้มติดต่อกัน 3 ครั้ง หรือเก่าเกิน 26 ชั่วโมง
- Quest transport outage 3 ครั้งภายใน 10 นาที
- Scheduled Runner restore failure 3 รายการภายใน 10 นาที

### ไม่แจ้ง Webhook

- User Token หมดอายุหรือบัญชีเดียวมีปัญหา
- Unknown Quest event
- Interaction error
- Discord shard สะดุดชั่วคราว

รายละเอียดสัญญาอยู่ที่ [`INCIDENT-DESIGN.md`](INCIDENT-DESIGN.md)

## Storage และ Backup

ระบบใช้ Storage profile เป็น Source of truth เดียวและไม่เขียนค่าอัตโนมัติกลับเข้า `process.env`

| Mode | ความหมาย |
|---|---|
| `memory` | ไม่มี Durability และ Backup ปิด |
| `local-development` | Local file สำหรับพัฒนา |
| `hosted-ephemeral` | Hosting ไม่มี Persistent mount และไฟล์อาจหายหลัง Redeploy |
| `persistent-candidate` | `/var/data` มีและเขียนได้ แต่ต้องผ่าน Controlled restart ก่อนถือว่า Verified |

ตำแหน่ง Backup อนุญาตเฉพาะ:

| Database | Backup |
|---|---|
| Local หรือ Path ทั่วไป | `./data/backups` |
| Path ใต้ `/var/data/` | `/var/data/backups` |

ระบบไม่รองรับ `DATABASE_BACKUP_DIR` และเก็บสูงสุด 7 Slot

Backup protection:

1. Backup สำเร็จ → `healthy`
2. Failure ครั้ง 1–2 → Render log เท่านั้น
3. Failure ครั้ง 3 หรือ Backup เก่าเกิน 26 ชั่วโมง → Incident
4. ระหว่างผิดปกติ Retry ทุก 15 นาที
5. สำเร็จอีกครั้ง → Recovery

## Health และ Status

- `GET /healthz` เปิดสาธารณะและตอบเฉพาะสถานะรวม
- HTTP `/api/status` ปิดเมื่อไม่มี `HEALTH_STATUS_TOKEN`
- Slash `/api-status` ใช้ได้เฉพาะ Owner/Admin/Manager
- Status แสดง Logging, Storage, Backup, Runner และ Quest API
- Status ไม่แสดง Webhook URL, Token หรือ Full database path

## คำสั่งและสิทธิ์

| คำสั่ง | หน้าที่ | สิทธิ์ |
|---|---|---|
| `/panel` | แผง One-shot: `START NOW` และ `STOP ALL` | Action ตรวจ Manager |
| `/run` | เริ่ม Auto Daily | Owner/Admin/Manager |
| `/stop` | เลือกหยุด Runner | เจ้าของ Runner; Action ตรวจสิทธิ์ |
| `/api-status` | สถานะระบบหลังบ้าน | Owner/Admin/Manager |
| `/ping` | ตรวจว่า Bot ออนไลน์ | ทั่วไป |
| `/help` | แสดงคำสั่ง | ทั่วไป |

Interaction ที่มีข้อมูลส่วนตัวตอบแบบ Ephemeral

## One-shot และ Auto Daily

One-shot รับหนึ่ง Token ต่อหนึ่งบรรทัดและหยุดเองเมื่อไม่มี Quest ที่รองรับหรือกด `STOP ALL`

Auto Daily:

1. ตรวจ Token และบัญชี
2. เข้ารหัส Token ก่อนบันทึก SQLite
3. ตรวจ Quest ทันที
4. ตรวจตามเวลา 00:00 / 08:00 / 16:00 ตาม `TIMEZONE`
5. Recheck ตาม Policy เมื่อจำเป็น
6. Restore หลัง Bot Restart

รองรับสูงสุด 10 Runner ต่อ Owner โดยนับ One-shot, Scheduled, Persisted offline และ Runner ที่กำลัง Cleanup การนับและเริ่ม Runner ถูก Serialize เพื่อกัน Race condition

## Stop lifecycle

บัญชีอยู่สถานะกำลังหยุดจน `job.done` จบจริง แม้หน้าจอรอผลหมดเวลาแล้ว บัญชีเดิมจึงเริ่มซ้ำไม่ได้ระหว่าง Cleanup

## การยืนยันผล Quest

ระบบไม่ถือว่า POST สำเร็จเพียงเพราะส่ง Request ได้:

- Progress ต้องดึง State ใหม่และเห็นค่าจาก Discord
- Quest เสร็จเมื่อเห็น `completed_at`
- Claim สำเร็จเมื่อเห็น `claimed_at`

Enroll, Claim, Video Progress และ Heartbeat ใช้ Verified mutation retry โดยตรวจ Fresh state ก่อนส่งซ้ำ และไม่ Retry HTTP 4xx แบบแน่นอน

## Database migration

เมื่อพบตาราง Tracker เก่า (`quests`, `guild_settings`, `quest_logs`) ระบบจะ:

1. สร้าง Backup ในตำแหน่งที่อนุญาต
2. ลบเฉพาะตาราง Tracker เก่าใน Transaction
3. คง `scheduled_runners` ไว้

Database open และ Migration failure มี Incident code แยกกันเพื่อให้ Rollback ถูกจุด

## ทดสอบ

```bash
npm run validate:quest-fixture
npm test
npm run check
npm audit --omit=dev --audit-level=high
```

CI ตรวจ Safe bootstrap, Storage profile, Backup threshold/recovery, Incident lifecycle, Webhook transport, Runner regressions, Backup destinations, Syntax และ Dependency audit

`npm run smoke:quest` เป็น Read-only: ตรวจบัญชีและอ่านรายการ Questเท่านั้น ไม่ Enroll, Progress, Heartbeat หรือ Claim

## Production และ Rollback

ก่อน Merge/Deploy ต้องทำตาม [`PRODUCTION-CHECKLIST.md`](PRODUCTION-CHECKLIST.md) โดยเฉพาะ:

- CI/Snyk/CodeRabbit ต้องเป็นของ HEAD ล่าสุด
- ไม่มี Review thread ค้าง
- ทดสอบ Webhook จริงด้วยข้อมูลจำลอง
- Restart/Redeploy แล้วยืนยัน Database, Backup และ Scheduled Runner ยังอยู่
- เก็บ Commit SHA และ Backup สำหรับ Rollback

> **คำเตือน:** การทำงานอัตโนมัติด้วยข้อมูลรับรองของบัญชีผู้ใช้มีความเสี่ยงด้านบัญชีและข้อกำหนดของแพลตฟอร์ม Unit Test และ CI ไม่สามารถทำให้ความเสี่ยงนี้หายไป ผู้ดูแลต้องตรวจสอบกฎปัจจุบันและยอมรับความเสี่ยงก่อนใช้งานจริง
