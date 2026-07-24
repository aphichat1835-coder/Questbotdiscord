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
- Render/Console logs เก็บ Error ทุกระดับ แต่ Discord Webhook ส่งเฉพาะเหตุฉุกเฉินของระบบ

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
```

ข้อกำหนด:

- `RUNNER_TOKEN_SECRET` ต้องยาวอย่างน้อย 16 ตัวอักษร เป็น Secret แบบสุ่ม และห้าม Commit
- `LOG_WEBHOOK_URL` ต้องเป็น Discord HTTPS Incoming Webhook ในห้องหลังบ้านที่มีเฉพาะเจ้าของระบบ
- `LOG_WEBHOOK_URL` ถือเป็น Credential ต้องหมุนใหม่ทันทีเมื่อสงสัยว่ารั่ว
- `LOG_CHANNEL_ID` เป็น Optional fallback สำหรับข้อความสถานะ Runner ไม่ใช่ Emergency Webhook
- `HEALTH_STATUS_TOKEN` เมื่อเปิดใช้ต้องเป็น Secret คนละค่ากับ Token อื่น
- ค่า Discord client profile ต้องอัปเดตพร้อมกันทั้งชุดและ Restart หลังเปลี่ยน
- ห้ามใช้ `DATABASE_BACKUP_DIR`; ระบบไม่รองรับ Backup path จาก Environment

## 3. Persistent storage

เมื่อใช้ Hosting ที่มี Persistent Volume:

- Mount `/var/data` แบบ Persistent และให้ Process เขียนได้
- เมื่อไม่ตั้ง `DATABASE_PATH` ระบบต้องเลือก `/var/data/quests.db` อัตโนมัติ
- Backup ต้องเปิดอัตโนมัติและเกิดที่ `/var/data/backups`
- ตรวจว่ามีสูงสุดตาม `DATABASE_BACKUP_RETENTION` และไม่เกิน 7 Slot
- Restart Deployment แล้วตรวจว่า Database และ Backup ยังอยู่

เมื่อไม่มี `/var/data` ระบบต้อง fallback เป็น `./data/quests.db` และ `./data/backups` พร้อมยอมรับว่าไฟล์อาจหายเมื่อ Redeploy

## 4. Emergency Webhook validation

ใช้ Webhook ทดสอบที่แยกจาก Production แล้วตรวจว่า:

1. เหตุฉุกเฉินที่บังคับทดสอบส่ง Rich Embed สำเร็จ
2. Embed มี Source, Severity, Uptime, Runtime และ Deployment
3. `allowed_mentions.parse` เป็น Array ว่างและข้อความไม่ Ping ผู้ใช้/Role/@everyone
4. Token, Secret, Cookie, CAPTCHA, Email และ Webhook URL ไม่ปรากฏใน Payload
5. Error ระดับบัญชีเดียว เช่น User Token หมดอายุ ไม่ส่ง Webhook
6. Quest Event ใหม่ที่เพียงยังไม่รองรับไม่ส่ง Emergency แต่ยังอยู่ใน Render logs
7. Process fatal, Database backup failure และ Quest API schema break ส่ง Emergency
8. HTTP 400 ไม่ Retry; Network, HTTP 429 และ 5xx Retry แบบจำกัด
9. เหตุซ้ำถูก Dedupe 10 นาที
10. Webhook ล้มไม่ทำให้ Bot ดับและมี Error ใน Render logs

## 5. Quality gates

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

- Repository shape
- Approved database backup destinations
- Unit/Regression tests
- Environment contract tests
- Emergency webhook classification/redaction/limit tests
- Syntax check ของ `src` และ `scripts`
- Production dependency audit

## 6. Controlled functional validation

ทดสอบใน Server และบัญชีทดสอบที่แยกจากบัญชีหลัก:

1. ผู้ใช้ทั่วไปเรียก `/api-status` แล้วต้องถูกปฏิเสธแบบ Ephemeral
2. Manager เรียก `/api-status` แล้วเห็นสถานะระบบ
3. ส่ง Modal เริ่ม Runner พร้อมกันหลายชุด แล้วจำนวนรวมต้องไม่เกิน 10
4. กด Stop ระหว่าง Runner ทำงาน แล้วบัญชีต้องอยู่สถานะ Cleanup จน Job จบจริง
5. เปิด Auto Daily, Restart Bot และตรวจว่า Scheduled Runner ถูก Restore
6. ตรวจข้อความ Runner ที่ยาวมากว่ายังไม่เกิน Discord message limit
7. ตรวจไฟล์ Backup Slot และ Retention โดยไม่ต้องตั้งค่าเปิดเอง
8. เรียก `/healthz` และตรวจว่าไม่เปิดเผยรายละเอียด
9. เรียก HTTP `/api/status` โดยไม่มี/มี Bearer token ผิด แล้วต้องได้ Unauthorized หรือ Not Found ตามการตั้งค่า
10. ทดสอบ Emergency Webhook ด้วย Error จำลองที่ไม่มี Secret จริง

## 7. Quest API verification boundary

`npm run smoke:quest` และ Workflow `Quest API smoke` เป็น Read-only เท่านั้น โดยตรวจบัญชีและอ่านรายการ Quest ไม่ Enroll, Progress, Heartbeat หรือ Claim

CI และ Smoke Test จึงไม่ใช่หลักฐานว่าการเปลี่ยนข้อมูลจริงผ่านครบทุก Flow การตรวจ Mutation จริงต้องผ่านการอนุมัติด้านความเสี่ยงและข้อกำหนดแพลตฟอร์มก่อน ห้ามใช้บัญชีหลักเป็นบัญชีทดลอง

## 8. Rollback

ก่อน Deploy:

- บันทึก Commit SHA ที่ใช้งานอยู่
- ตรวจว่า Backup ล่าสุดเปิดอ่านได้
- เก็บ Environment เดิมอย่างปลอดภัย
- เก็บ Webhook URL เดิมโดยไม่พิมพ์ลง Ticket/Log

เมื่อพบปัญหา:

1. หยุด Deployment ใหม่
2. Rollback ไป Commit ก่อนหน้า
3. Restore Database เฉพาะเมื่อยืนยันว่า Schema/Data เสียหาย
4. เปลี่ยน Secret และ Webhook URL ทันทีหากสงสัยว่ารั่ว
5. ตรวจ Render log และ Webhook embed ที่ผ่าน Redaction แล้วบันทึก Root cause ก่อน Deploy ใหม่

## 9. เกณฑ์อนุมัติ

อนุมัติ Production ได้เมื่อ CI ผ่านทั้งหมด, Persistent storage ผ่านการ Restart, Emergency Webhook ผ่านการทดสอบแบบไม่ใช้ Secret จริง, Permission ถูกต้อง, Runner limit/Stop lifecycle ผ่านการทดสอบ และผู้ดูแลยอมรับความเสี่ยงด้านบัญชีและข้อกำหนดแพลตฟอร์มอย่างชัดเจน

## 10. Repository data safety

- `git ls-files` ต้องไม่พบ `.db`, `.sqlite`, WAL/SHM หรือไฟล์ใน Runtime `data/backups`
- ตรวจ Git history และ Secret scanning ก่อน Merge หากฐานข้อมูลเคยถูก Commit
- หากพบข้อมูลรับรองหรือ Webhook URL จริง ให้หมุน Secret/Token/Webhook ก่อน Deploy
- ตั้ง Production Replica เป็น 1 หรือยืนยันว่าทุก Process ใช้ Shared `DATABASE_PATH` เดียวกันและ Lease ทำงาน