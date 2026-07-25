# Production Readiness Checklist

เอกสารนี้ใช้ตรวจรับ Pull Request หรือกิ่ง Release ก่อน Merge หรือ Deploy ระบบ NeverDie Quest Bot

## 1. ขอบเขตที่ต้องยืนยัน

- Repository เป็น Bot-only และไม่มี Desktop/Tauri/CDP/Game Simulator กลับเข้ามา
- Runner สูงสุด 10 บัญชีต่อ Owner และคำสั่งพร้อมกันไม่ทำให้เกินจำนวน
- One-shot หยุดเองเมื่อไม่มี Quest ที่รองรับ
- Auto Daily ตรวจทันทีและตามเวลา 00:00 / 08:00 / 16:00 ใน Timezone ที่กำหนด
- Stop รอ Cleanup และไม่อนุญาตให้บัญชีเดิมเริ่มซ้ำระหว่างกำลังหยุด
- `/api-status` ใช้ได้เฉพาะ Owner/Admin/Manager
- HTTP `/api/status` ปิดเมื่อไม่มี `HEALTH_STATUS_TOKEN` และใช้ Exact Bearer token เมื่อเปิด
- Render/Console logs เก็บ Error ทุกระดับ
- Discord Webhook ส่งเฉพาะ Structured Incident ตาม Policy และ Threshold
- Incident, Fatal shutdown และ Resource cleanup ต้องไม่ทำงานซ้อนจาก Error burst เดียวกัน

## 2. Environment

ค่าหลักที่ต้องตั้งครบ 6 ค่า:

```env
DISCORD_BOT_TOKEN=
DISCORD_CLIENT_ID=
DISCORD_GUILD_ID=
OWNER_ID=
RUNNER_TOKEN_SECRET=
LOG_WEBHOOK_URL=
```

ค่า Optional ที่ระบบมีค่าเริ่มต้นหรือปิดอย่างปลอดภัยให้เอง:

```env
MANAGER_ROLE_ID=
LOG_CHANNEL_ID=
TIMEZONE=Asia/Bangkok
DATABASE_PATH=
DATABASE_BACKUP_ENABLED=
DATABASE_BACKUP_RETENTION=7
HEALTH_STATUS_TOKEN=
PORT=
```

ข้อกำหนด:

- `RUNNER_TOKEN_SECRET` ต้องยาวอย่างน้อย 16 ตัวอักษร เป็น Secret แบบสุ่ม และห้าม Commit
- `LOG_WEBHOOK_URL` ต้องเป็น Discord HTTPS Incoming Webhook ในห้องหลังบ้านที่มีเฉพาะเจ้าของระบบ
- `LOG_WEBHOOK_URL` ถือเป็น Credential ต้องหมุนใหม่ทันทีเมื่อสงสัยว่ารั่ว
- `LOG_CHANNEL_ID` เป็น Optional fallback สำหรับข้อความสถานะ Runner ไม่ใช่ Emergency Webhook
- `HEALTH_STATUS_TOKEN` เมื่อเปิดใช้ต้องเป็น Secret คนละค่ากับ Token อื่น
- ค่า Discord client profile ต้องอัปเดตพร้อมกันทั้งชุดและ Restart หลังเปลี่ยน
- ห้ามใช้ `DATABASE_BACKUP_DIR`; ระบบไม่รองรับ Backup path จาก Environment
- Storage resolver และ Runtime ห้ามเขียนค่าอัตโนมัติกลับเข้า `process.env.DATABASE_PATH`

## 3. Safe bootstrap และ Shutdown

ตรวจว่า Startup failure ไม่ทำให้ Process ค้างหรือเปิดระบบเพียงบางส่วน:

1. Bootstrap handlers ถูกติดตั้งก่อน Dynamic import ของ Runtime
2. Config/Module import failure ถูกบันทึกโดยไม่พึ่ง SQLite หรือ Discord Client
3. Database open failure ใช้ Incident `DATABASE_OPEN_FAILED`
4. Database schema/migration failure ใช้ Incident `DATABASE_MIGRATION_FAILED`
5. Runtime lease conflict/lost ทำให้ Process ปิดอย่างปลอดภัย
6. Health server bind failure ต้อง Reject Startup ไม่ปล่อย Bot ทำงานต่อโดยไม่มี Health endpoint
7. Discord login failure ส่ง Incident แล้ว Shutdown
8. Fatal report ใช้ Budget จำกัด 3.5 วินาทีและล้าง Timer เมื่อ Report จบ
9. Runtime ใช้ Fatal promise เดียวและ Shutdown promise เดียว
10. Signal ปกติที่ชนกับ Fatal error ต้องจบด้วย Exit code ที่รุนแรงที่สุด
11. Dashboard ที่กำลัง Bind ต้องถูกติดตามและปิด ไม่ทิ้ง Server ที่ไม่มีเจ้าของ

## 4. Storage truth

ระบบต้องรายงาน Storage mode ตามความจริง:

- `memory` — ไม่มี Durability และ Backup ปิดเสมอ
- `local-development` — Local file สำหรับ Development
- `hosted-ephemeral` — Hosting ไม่มี Persistent mount และต้องแสดง Warning
- `persistent-candidate` — `/var/data` มีและเขียนได้ แต่ `durabilityVerified` ยังเป็น `false`

Fixed backup mappings:

- Database นอก `/var/data/` → `./data/backups`
- Database ใต้ `/var/data/` → `/var/data/backups`

Directory creation, Slot backup, Slot cleanup, Latest-backup inspection และ Legacy migration backup ต้องใช้ Backup profile เดียวกัน Profile อื่นต้องถูกปฏิเสธ

เมื่อใช้ Hosting ที่มี Persistent Volume:

- Mount `/var/data` แบบ Persistent และให้ Process เขียนได้
- เมื่อไม่ตั้ง `DATABASE_PATH` ระบบต้องเลือก `/var/data/quests.db` อัตโนมัติ
- Backup ต้องเกิดที่ `/var/data/backups`
- ตรวจว่ามีสูงสุดตาม `DATABASE_BACKUP_RETENTION` และไม่เกิน 7 Slot
- Restart/Redeploy แล้วตรวจว่า Database และ Backup ยังอยู่
- ห้ามถือว่า Persistent verified จากการตรวจ Directory อย่างเดียว

เมื่อไม่มี `/var/data` ระบบต้อง fallback เป็น `./data/quests.db` และ `./data/backups` พร้อมรายงาน `hosted-ephemeral` บน Hosting

## 5. Backup protection

ตรวจ State machine ต่อไปนี้:

1. Backup สำเร็จ → `healthy`
2. Failure ครั้งแรกและครั้งที่สอง → Render log เท่านั้น
3. Failure ติดต่อกันครั้งที่ 3 → เปิด `BACKUP_PROTECTION_LOST` หนึ่งรายการ
4. Backup เก่าเกิน 26 ชั่วโมงและความพยายามใหม่ล้ม → เปิด Incident แม้เป็น Failure ครั้งแรกในรอบนั้น
5. ขณะ Incident เปิดอยู่ Failure ถัดไปต้องอยู่ใน Render log โดยไม่ยิง Webhook ซ้ำ
6. Fast retry ทุก 15 นาทีสูงสุด 3 รอบ จากนั้นกลับตาราง Daily
7. เมื่อสำเร็จอีกครั้ง ส่ง Recovery ด้วย Incident ID เดิม
8. Recovery delivery ที่ล้มต้องถูกเก็บเป็น Pending และ Retry ใน Backup success รอบถัดไป
9. Failure ใหม่หลัง Pending recovery ต้องเริ่ม Incident lifecycle ใหม่เมื่อถึง Threshold
10. `/api/status` แสดง Last success, age, consecutive failures, fast retry count/limit, incident open, recovery pending และ next attempt
11. Status ห้ามแสดง Full database path หรือ Backup directory

## 6. Emergency Webhook validation

ใช้ Webhook ทดสอบที่แยกจาก Production แล้วตรวจว่า:

1. Incident ที่บังคับทดสอบส่ง Rich Embed สำเร็จ
2. Embed มี Status, Incident code, Incident ID, Impact, Action, Runtime และ Deployment
3. `allowed_mentions.parse` เป็น Array ว่างและข้อความไม่ Ping ผู้ใช้/Role/@everyone
4. Token, Secret, Cookie, CAPTCHA, Email, Ciphertext, Password, Compound secret keys และ Webhook URL ไม่ปรากฏใน Payload
5. Context ใช้ Deep-frozen Allowlist ต่อ Incident code
6. Incident code ที่ไม่ใช่ Own property เช่น `constructor`, `toString`, `__proto__` ถูกปฏิเสธ
7. HTTP 400/401/403/404 ไม่ Retry
8. HTTP 429/502/503/504 Retry ได้สูงสุดหนึ่งครั้ง
9. Retryable response สองครั้งติดต้องจบเป็น `delivery_unknown` ที่ Attempts = 2
10. Network timeout หลังเริ่ม POST เป็น `delivery_unknown` และไม่ส่ง POST ซ้ำทันทีแบบเดาสุ่ม
11. Concurrent incident ของ `code + scope` เดียวกันต้องมี Network delivery เพียงหนึ่งรายการ
12. Incident ที่ส่งสำเร็จคงสถานะเปิดและ Suppress เหตุซ้ำจนกว่าจะ Recovery
13. Delivery ที่ล้มมี Retry guard และเหตุครั้งถัดไปสามารถลองใหม่ด้วย Incident ID เดิม
14. Webhook ล้มไม่ทำให้ Bot ดับและมี Error ใน Render logs
15. Recovery ใช้ Incident ID เดิม และ Recovery ที่ล้มสามารถ Retry ได้
16. Incident/Counter state เก่าถูก Prune และ Legacy threshold ถูก Reset หลัง Escalate

## 7. Quest และ Restore policy

- User Token หมดอายุหรือบัญชีเดียวมีปัญหาไม่ส่ง Webhook
- Unknown Quest event ไม่ส่ง Emergency
- Quest schema/parser break ส่ง `QUEST_API_SCHEMA_INCOMPATIBLE` ทันที
- Quest transport outage ต้องพบ 3 ครั้งภายใน 10 นาทีจึงส่ง `QUEST_API_TRANSPORT_OUTAGE`
- Scheduled Runner restore failure ต้องครบ 3 รายการภายใน 10 นาทีจึงส่ง Incident เดียว
- Restore payload แสดงเฉพาะยอดรวม ห้ามมี User Token, Username หรือ Account ID
- Transitional bridge อยู่ใน `legacy-incident-policy.js` และมี Regression tests จนกว่า Caller ใหญ่จะถูกแยกโมดูล

## 8. Quality gates

รันจากโฟลเดอร์ `bot`:

```bash
npm ci --ignore-scripts --no-fund --no-audit
npm rebuild better-sqlite3 --foreground-scripts
npm run validate:quest-fixture
npm test
npm run check
npm audit --omit=dev --audit-level=high
```

GitHub Actions ต้องผ่านทั้ง:

- Repository shape และ Runtime data safety
- Sanitized Quest fixture
- Fixed database backup destinations
- Incident/Storage architecture boundaries
- Environment contract และ Semantic no-mutation tests
- Safe bootstrap, Health bind และ Serialized shutdown tests
- Storage profile และ Backup profile consistency tests
- Backup threshold, bounded retry และ Recovery retry tests
- Incident classification, immutability, redaction, concurrency, delivery และ Recovery lifecycle tests
- Webhook URL validation, redirect safety และ Retry ceiling tests
- Unit/Regression tests และ Coverage gate
- Syntax check ของ `src` และ `scripts`
- Production dependency audit

Status จาก CI, Snyk, Codacy, SonarCloud และ CodeRabbit ต้องเป็นของ HEAD SHA ล่าสุด ห้ามใช้ผลจาก Commit เก่า

## 9. Controlled functional validation

ทดสอบใน Server และบัญชีทดสอบที่แยกจากบัญชีหลัก:

1. ผู้ใช้ทั่วไปเรียก `/api-status` แล้วต้องถูกปฏิเสธแบบ Ephemeral
2. Manager เรียก `/api-status` แล้วเห็น Logging, Storage และ Backup state โดยไม่มี Secret
3. ส่ง Modal เริ่ม Runner พร้อมกันหลายชุด แล้วจำนวนรวมต้องไม่เกิน 10
4. กด Stop ระหว่าง Runner ทำงาน แล้วบัญชีต้องอยู่สถานะ Cleanup จน Job จบจริง
5. เปิด Auto Daily, Restart Bot และตรวจว่า Scheduled Runner ถูก Restore
6. ตรวจข้อความ Runner ที่ยาวมากว่ายังไม่เกิน Discord message limit
7. ตรวจไฟล์ Backup Slot และ Retention
8. เรียก `/healthz` และตรวจว่าไม่เปิดเผยรายละเอียด
9. เรียก HTTP `/api/status` โดยไม่มี/มี Bearer token ผิด แล้วต้องได้ Unauthorized หรือ Not Found ตามการตั้งค่า
10. ทดสอบ Emergency Webhook ด้วย Error จำลองที่ไม่มี Secret จริง
11. ทดสอบ Webhook ถูกลบ/หมดอายุแล้ว Bot ยังทำงานและ Render log มีหลักฐาน
12. ทดสอบ Incident burst แล้วห้อง Webhook ได้เพียงหนึ่งข้อความ
13. ทดสอบ Backup ล้มต่อเนื่องแล้วไม่สแปมทุก Fast retry
14. Restart/Redeploy แล้ว Database, Backup และ Scheduled Runner ยังอยู่

## 10. Quest API verification boundary

`npm run smoke:quest` และ Workflow `Quest API smoke` เป็น Read-only เท่านั้น โดยตรวจบัญชีและอ่านรายการ Quest ไม่ Enroll, Progress, Heartbeat หรือ Claim

CI และ Smoke Test จึงไม่ใช่หลักฐานว่าการเปลี่ยนข้อมูลจริงผ่านครบทุก Flow การตรวจ Mutation จริงต้องผ่านการอนุมัติด้านความเสี่ยงและข้อกำหนดแพลตฟอร์มก่อน ห้ามใช้บัญชีหลักเป็นบัญชีทดลอง

## 11. Rollback

ก่อน Deploy:

- บันทึก Commit SHA ที่ใช้งานอยู่
- ตรวจว่า Backup ล่าสุดเปิดอ่านได้
- เก็บ Environment เดิมอย่างปลอดภัย
- เก็บ Webhook URL เดิมโดยไม่พิมพ์ลง Ticket/Log
- ยืนยันว่ากิ่ง Release ยังไม่ถูกลบ

เมื่อพบปัญหา:

1. หยุด Deployment ใหม่
2. Rollback ไป Commit ก่อนหน้า
3. Restore Database เฉพาะเมื่อยืนยันว่า Schema/Data เสียหาย
4. เปลี่ยน Secret และ Webhook URL ทันทีหากสงสัยว่ารั่ว
5. ตรวจ Render log และ Incident ID แล้วบันทึก Root cause
6. เพิ่ม Regression test ก่อน Deploy ใหม่

## 12. เกณฑ์อนุมัติ

อนุมัติ Production ได้เมื่อ:

- CI ของ HEAD ล่าสุดผ่านทั้งหมด
- Snyk, Codacy, SonarCloud และ CodeRabbit ผ่านหรือ Warning ถูกวิเคราะห์และยอมรับอย่างมีเหตุผล
- ไม่มี Review thread ค้าง
- Persistent storage ผ่าน Controlled restart/redeploy
- Emergency Webhook ผ่าน Test แบบไม่ใช้ Secret จริง
- Permission, Runner limit และ Stop lifecycle ผ่าน
- Backup threshold, bounded retry และ Recovery retry ผ่าน
- Rollback path ถูกยืนยัน
- ผู้ดูแลยอมรับความเสี่ยงด้านบัญชีและข้อกำหนดแพลตฟอร์มอย่างชัดเจน

## 13. Repository data safety

- `git ls-files` ต้องไม่พบ `.db`, `.sqlite`, WAL/SHM หรือไฟล์ใน Runtime `data/backups`
- ตรวจ Git history และ Secret scanning ก่อน Merge หากฐานข้อมูลเคยถูก Commit
- หากพบข้อมูลรับรองหรือ Webhook URL จริง ให้หมุน Secret/Token/Webhook ก่อน Deploy
- ตั้ง Production Replica เป็น 1 หรือยืนยันว่าทุก Process ใช้ Shared `DATABASE_PATH` เดียวกันและ Lease ทำงาน
