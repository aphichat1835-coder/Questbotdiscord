# NeverDie Quest Bot — คู่มือระบบปัจจุบัน

ระบบนี้เป็น Discord Bot แบบ Bot-only สำหรับตรวจและดำเนินการกับ Discord Quest ที่รองรับ ไม่มี Desktop/Tauri, CDP launcher, Game Simulator หรือ Quest Tracker แบบกรอก Quest ID

## ติดตั้ง

ต้องใช้ Node.js ตาม `.node-version` และ `package.json`

```bash
npm ci
cp .env.example .env
npm run register
npm start
```

หลังแก้ Slash command ให้รัน `npm run register` ใหม่

## Environment

### จำเป็น

- `DISCORD_BOT_TOKEN` — Token ของ Bot
- `DISCORD_CLIENT_ID` — Application/Client ID
- `DISCORD_GUILD_ID` — Server ที่ลงทะเบียนคำสั่ง
- `OWNER_ID` — Discord User ID ของเจ้าของระบบ

### Runner และสิทธิ์

- `RUNNER_TOKEN_SECRET` — Secret ยาวและสุ่มสำหรับเข้ารหัส Token ของ Auto Daily
- `MANAGER_ROLE_ID` — Role ที่ใช้ Start/Stop Runner และดู `/api-status`; Owner/Admin ใช้ได้เสมอ
- `TIMEZONE` — Timezone ของตารางเวลา ค่าเริ่มต้น `Asia/Bangkok`
- `LOG_CHANNEL_ID` — ห้องสำรองสำหรับสถานะและ Error

### Database และ Backup

- `DATABASE_PATH` — ค่าเริ่มต้น `./data/quests.db`
- `DATABASE_BACKUP_ENABLED` — เปิด/ปิด Backup แบบ Slot
- `DATABASE_BACKUP_RETENTION` — จำนวน Slot ที่เก็บ ค่า 1–7

ระบบไม่รองรับ `DATABASE_BACKUP_DIR` และไม่รับ Backup path อิสระจาก Environment

ตำแหน่งที่อนุญาตมีสองแบบ:

| Database | Backup |
|---|---|
| `./data/quests.db` หรือ Path ทั่วไป | `./data/backups` |
| Path ใต้ `/var/data/` | `/var/data/backups` |

แนะนำบน Hosting ที่มี Persistent Volume:

```env
DATABASE_PATH=/var/data/quests.db
DATABASE_BACKUP_ENABLED=true
DATABASE_BACKUP_RETENTION=7
```

ต้อง Mount `/var/data` แบบ Persistent ไม่เช่นนั้นทั้ง Database และ Backup จะหายเมื่อ Redeploy

### Health endpoint

- `HEALTH_STATUS_TOKEN` — Bearer token สำหรับ HTTP `GET /api/status`
- หากไม่ตั้งค่า Endpoint รายละเอียดจะปิด
- `GET /healthz` เปิดสาธารณะและตอบเฉพาะสถานะรวม

## Discord client profile

Runner ใช้ Client profile กลางหนึ่งชุดตลอดอายุ Process ค่าจะถูกอ่านตอนเริ่ม Bot และ **ไม่ Refresh อัตโนมัติทุก 6 ชั่วโมงอีกแล้ว** การแก้ค่าต้องทำพร้อมกันทั้งชุดแล้ว Restart:

- `DISCORD_CLIENT_VERSION`
- `DISCORD_CHROME_VERSION`
- `DISCORD_ELECTRON_VERSION`
- `DISCORD_BUILD_NUMBER`
- `DISCORD_NATIVE_BUILD_NUMBER`
- `DISCORD_LOCALE`
- `DISCORD_TIMEZONE`

ถ้าไม่กำหนด ระบบใช้ Profile สำรองใน Source code ห้ามเปลี่ยนเพียงค่าเดียวแบบเดาสุ่ม เพราะ Header จะไม่สอดคล้องกัน

## คำสั่งและสิทธิ์

| คำสั่ง | หน้าที่ | สิทธิ์ |
|---|---|---|
| `/panel` | แผง One-shot: `START NOW` และ `STOP ALL` | Action ตรวจ Manager |
| `/run` | เริ่ม Auto Daily | Owner/Admin/Manager |
| `/stop` | เลือกหยุด Runner | เจ้าของ Runner; Action ตรวจสิทธิ์ |
| `/api-status` | สถานะ Database, Runner และ Quest API | Owner/Admin/Manager เท่านั้น |
| `/ping` | ตรวจว่า Bot ออนไลน์ | ทั่วไป |
| `/help` | แสดงคำสั่ง | ทั่วไป |

Interaction ที่มีข้อมูลส่วนตัวตอบแบบ Ephemeral

## One-shot Runner

เปิด `/panel` แล้วกด `START NOW` กรอกหนึ่ง Token ต่อหนึ่งบรรทัด ระบบหยุดเองเมื่อไม่มี Quest ที่รองรับหรือเมื่อกด `STOP ALL`

## Auto Daily Runner

ใช้ `/run` ระบบจะ:

1. ตรวจ Token และบัญชี
2. เข้ารหัส Token ก่อนบันทึก SQLite
3. ตรวจ Quest ทันที
4. ตรวจตามเวลา 00:00 / 08:00 / 16:00 ตาม `TIMEZONE`
5. ตรวจซ้ำทุกช่วง Recheck ที่กำหนดเมื่อจำเป็น
6. Restore Scheduled Runner หลัง Bot Restart

ใช้ `/stop` เพื่อหยุดหนึ่งบัญชี หลายบัญชี หรือทั้งหมด

## ขีดจำกัดและการป้องกันคำสั่งพร้อมกัน

รองรับสูงสุด 10 Runner ต่อ Owner โดยนับรวม:

- One-shot ที่กำลังทำงาน
- Auto Daily ในหน่วยความจำ
- Auto Daily ที่บันทึกไว้แต่ยัง Offline
- Runner ที่กำลัง Stop/Cleanup

การนับช่องและเริ่ม Runner ถูก Serialize ต่อ Owner จึงไม่เกิดกรณี Modal สองชุดคำนวณช่องว่างเดียวกันแล้วเปิดเกิน 10 ตัว Owner คนละคนยังทำงานพร้อมกันได้

## Stop lifecycle

เมื่อสั่ง Stop ระบบจะคงสถานะบัญชีว่า “กำลังหยุด” จน `job.done` จบจริง แม้หน้าจอรอผลหมดเวลาแล้วก็ตาม บัญชีเดิมจึงเริ่มซ้ำไม่ได้ระหว่าง Cleanup

## การยืนยันผล Quest

ระบบไม่ถือว่าคำขอ POST สำเร็จเพียงเพราะส่ง Request ได้:

- Progress ต้องดึง State ใหม่และเห็นค่าจาก Discord
- Quest เสร็จเมื่อเห็น `completed_at`
- Claim สำเร็จเมื่อเห็น `claimed_at`

Enroll, Claim, Video Progress และ Heartbeat ใช้ Verified mutation retry:

1. เมื่อ Network error, Timeout, HTTP 429 หรือ 5xx ให้ดึง State ล่าสุด
2. ถ้า State เปลี่ยนแล้ว ไม่ส่งซ้ำ
3. ถ้ายังไม่เปลี่ยน รอตาม Retry delay และส่งซ้ำได้อีกหนึ่งครั้ง
4. HTTP 4xx แบบแน่นอน เช่น 400 ไม่ Retry

## สถานะหลายบัญชี

Quest API status ถูกเก็บแยกตาม Job/Account:

- `/api-status` แสดง Aggregate และสถานะบัญชีของผู้เรียก แต่ใช้ได้เฉพาะ Manager ขึ้นไป
- HTTP `/api/status` แสดง `questApi.aggregate` และ `questApi.accounts` เมื่อ Bearer token ถูกต้อง
- Status ไม่มี Token หรือ Ciphertext
- ประวัติ Job ที่หยุดแล้วถูกจำกัดจำนวน

## ฐานข้อมูลและ Migration

ระบบใช้ตาราง `scheduled_runners` สำหรับ Auto Daily เมื่อพบตาราง Tracker เก่า (`quests`, `guild_settings`, `quest_logs`) ระบบจะ:

1. สำรอง Database ไปยัง Backup directory ที่อนุญาต
2. ลบเฉพาะตาราง Tracker เก่า
3. คง `scheduled_runners` ไว้

Backup รายวันใช้ชื่อ Slot คงที่สูงสุด 7 ไฟล์ ไม่สะสมไม่สิ้นสุด และไม่รับ Destination จากผู้ใช้

## Sanitized Quest fixture

`fixtures/quest-api.sample.json` เป็น Fixture ที่ไม่มี Token, Cookie, Email, Username หรือ Account ID จริง

```bash
npm run validate:quest-fixture
```

CI จะล้มเมื่อ Fixture หาย, Schema หลักเสีย, Parser อ่านไม่ได้ หรือมีชื่อ Field ข้อมูลลับที่ห้ามเก็บ

## Read-only Quest API smoke

Smoke Test ตรวจบัญชีและดึงรายการ Quest จริงเท่านั้น ไม่ Enroll, Progress, Heartbeat หรือ Claim

```bash
DISCORD_USER_TOKEN='ส่งผ่าน Environment เท่านั้น' npm run smoke:quest
```

แนะนำให้ตั้ง `EXPECTED_DISCORD_ACCOUNT_ID` เพื่อป้องกัน Token ผิดบัญชี Script จะไม่พิมพ์ Token, Username หรือ Account ID ลง Log

GitHub Actions Workflow `Quest API smoke` อ่าน Secrets:

- `DISCORD_USER_TOKEN`
- `EXPECTED_DISCORD_ACCOUNT_ID` — แนะนำให้ตั้ง

Smoke แบบ Read-only ไม่ใช่หลักฐานว่าการเปลี่ยนข้อมูลจริงผ่านครบทุก Flow ดูขอบเขตการตรวจรับที่ [`PRODUCTION-CHECKLIST.md`](PRODUCTION-CHECKLIST.md)

## ทดสอบก่อน Commit/PR

```bash
npm ci
npm run validate:quest-fixture
npm test
npm run check
npm audit --omit=dev --audit-level=high
```

`npm run check` ตรวจ Syntax ทั้ง `src` และ `scripts`

## Production และ Rollback

ใช้ [`PRODUCTION-CHECKLIST.md`](PRODUCTION-CHECKLIST.md) เพื่อตรวจ Environment, Persistent storage, Permission, Runner limit, Stop lifecycle, Restart/Restore, Health endpoint และ Rollback

> **คำเตือน:** การทำงานอัตโนมัติด้วยข้อมูลรับรองของบัญชีผู้ใช้มีความเสี่ยงด้านบัญชีและข้อกำหนดของแพลตฟอร์ม Unit Test และ CI ไม่สามารถทำให้ความเสี่ยงนี้หายไป ผู้ดูแลต้องตรวจสอบกฎปัจจุบันและยอมรับความเสี่ยงก่อนใช้งานจริง
