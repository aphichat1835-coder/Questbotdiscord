# Production Readiness Checklist

เอกสารนี้ใช้ตรวจรับกิ่ง `ss` ก่อน Merge หรือ Deploy ระบบ NeverDie Quest Bot

## 1. ขอบเขตที่ต้องยืนยัน

- Repository เป็น Bot-only และไม่มี Desktop/Tauri/CDP/Game Simulator กลับเข้ามา
- Runner สูงสุด 10 บัญชีต่อ Owner และคำสั่งพร้อมกันไม่ทำให้เกินจำนวน
- One-shot หยุดเองเมื่อไม่มี Quest ที่รองรับ
- Auto Daily ตรวจทันทีและตามเวลา 00:00 / 08:00 / 16:00 ใน Timezone ที่กำหนด
- Stop รอ Cleanup และไม่อนุญาตให้บัญชีเดิมเริ่มซ้ำระหว่างกำลังหยุด
- `/api-status` ใช้ได้เฉพาะ Owner/Admin/Manager
- HTTP `/api/status` ปิดเมื่อไม่มี `HEALTH_STATUS_TOKEN` และใช้ Exact Bearer token เมื่อเปิด

## 2. Environment

ตรวจว่าตั้งค่าอย่างน้อย:

```env
DISCORD_BOT_TOKEN=
DISCORD_CLIENT_ID=
DISCORD_GUILD_ID=
OWNER_ID=
MANAGER_ROLE_ID=
RUNNER_TOKEN_SECRET=
TIMEZONE=Asia/Bangkok
DATABASE_PATH=/var/data/quests.db
DATABASE_BACKUP_ENABLED=true
DATABASE_BACKUP_RETENTION=7
HEALTH_STATUS_TOKEN=
```

ข้อกำหนด:

- `RUNNER_TOKEN_SECRET` ต้องเป็น Secret ยาวและสุ่ม ห้าม Commit
- `HEALTH_STATUS_TOKEN` ต้องเป็น Secret คนละค่ากับ Token อื่น
- ค่า Discord client profile ต้องอัปเดตพร้อมกันทั้งชุดและ Restart หลังเปลี่ยน
- ห้ามใช้ `DATABASE_BACKUP_DIR`; ระบบไม่รองรับ Backup path จาก Environment

## 3. Persistent storage

เมื่อใช้ Hosting ที่มี Persistent Volume:

- ตั้ง `DATABASE_PATH=/var/data/quests.db`
- ตรวจว่า `/var/data` ถูก Mount แบบ Persistent
- Backup ต้องเกิดที่ `/var/data/backups`
- ตรวจว่ามีสูงสุดตาม `DATABASE_BACKUP_RETENTION` และไม่เกิน 7 Slot
- Restart Deployment แล้วตรวจว่า Database และ Backup ยังอยู่

Local development ใช้ `./data/quests.db` และ `./data/backups`

## 4. Quality gates

รันจากโฟลเดอร์ `bot`:

```bash
npm ci
npm run validate:quest-fixture
npm test
npm run check
npm audit --omit=dev --audit-level=high
```

GitHub Actions ต้องผ่านทั้ง:

- Repository shape
- Approved database backup destinations
- Unit/Regression tests
- Syntax check ของ `src` และ `scripts`
- Production dependency audit

## 5. Controlled functional validation

ทดสอบใน Server และบัญชีทดสอบที่แยกจากบัญชีหลัก:

1. ผู้ใช้ทั่วไปเรียก `/api-status` แล้วต้องถูกปฏิเสธแบบ Ephemeral
2. Manager เรียก `/api-status` แล้วเห็นสถานะระบบ
3. ส่ง Modal เริ่ม Runner พร้อมกันหลายชุด แล้วจำนวนรวมต้องไม่เกิน 10
4. กด Stop ระหว่าง Runner ทำงาน แล้วบัญชีต้องอยู่สถานะ Cleanup จน Job จบจริง
5. เปิด Auto Daily, Restart Bot และตรวจว่า Scheduled Runner ถูก Restore
6. ตรวจข้อความ Runner ที่ยาวมากว่ายังไม่เกิน Discord message limit
7. เปิด Backup แล้วตรวจไฟล์ Slot และ Retention
8. เรียก `/healthz` และตรวจว่าไม่เปิดเผยรายละเอียด
9. เรียก HTTP `/api/status` โดยไม่มี/มี Bearer token ผิด แล้วต้องได้ Unauthorized หรือ Not Found ตามการตั้งค่า

## 6. Quest API verification boundary

`npm run smoke:quest` และ Workflow `Quest API smoke` เป็น Read-only เท่านั้น โดยตรวจบัญชีและอ่านรายการ Quest ไม่ Enroll, Progress, Heartbeat หรือ Claim

CI และ Smoke Test จึงไม่ใช่หลักฐานว่าการเปลี่ยนข้อมูลจริงผ่านครบทุก Flow การตรวจ Mutation จริงต้องผ่านการอนุมัติด้านความเสี่ยงและข้อกำหนดแพลตฟอร์มก่อน ห้ามใช้บัญชีหลักเป็นบัญชีทดลอง

## 7. Rollback

ก่อน Deploy:

- บันทึก Commit SHA ที่ใช้งานอยู่
- ตรวจว่า Backup ล่าสุดเปิดอ่านได้
- เก็บ Environment เดิมอย่างปลอดภัย

เมื่อพบปัญหา:

1. หยุด Deployment ใหม่
2. Rollback ไป Commit ก่อนหน้า
3. Restore Database เฉพาะเมื่อยืนยันว่า Schema/Data เสียหาย
4. เปลี่ยน Secret ทันทีหากสงสัยว่ารั่ว
5. ตรวจ Log ที่ผ่าน Redaction และบันทึก Root cause ก่อน Deploy ใหม่

## 8. เกณฑ์อนุมัติ

อนุมัติ Production ได้เมื่อ CI ผ่านทั้งหมด, Persistent storage ผ่านการ Restart, Permission ถูกต้อง, Runner limit/Stop lifecycle ผ่านการทดสอบ และผู้ดูแลยอมรับความเสี่ยงด้านบัญชีและข้อกำหนดแพลตฟอร์มอย่างชัดเจน
