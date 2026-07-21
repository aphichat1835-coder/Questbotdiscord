# NeverDie Quest Bot — คู่มือ

## ติดตั้ง

```bash
npm ci
cp .env.example .env
npm run register
npm start
```

## Environment หลัก

- `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_GUILD_ID`, `OWNER_ID` — จำเป็น
- `RUNNER_TOKEN_SECRET` — อย่างน้อย 16 ตัวอักษรสำหรับ Auto Daily
- `TIMEZONE` — ตารางเวลา Bot ค่าเริ่มต้น `Asia/Bangkok`
- `MANAGER_ROLE_ID` — Role ที่ใช้ Start Runner; Owner/Admin ใช้ได้เสมอ
- `LOG_CHANNEL_ID` — ห้องสำรองสำหรับสถานะและ Error
- `DATABASE_PATH` — ค่าเริ่มต้น `./data/quests.db`
- `DATABASE_BACKUP_DIR`, `DATABASE_BACKUP_RETENTION` — ระบบสำรองฐานข้อมูล
- `HEALTH_STATUS_TOKEN` — รหัส Bearer สำหรับ HTTP `/api/status`; หากไม่ตั้ง Endpoint นี้จะปิด

## Discord client profile

Runner ใช้ Client profile ชุดเดียวที่สอดคล้องกัน ไม่ดึง Discord build แล้วนำไปผสมกับ Electron รุ่นทั่วไป ค่าต่อไปนี้เป็น Optional override และต้องตรวจสอบ/อัปเดตพร้อมกันเป็นชุด:

- `DISCORD_CLIENT_VERSION`
- `DISCORD_CHROME_VERSION`
- `DISCORD_ELECTRON_VERSION`
- `DISCORD_BUILD_NUMBER`
- `DISCORD_NATIVE_BUILD_NUMBER`
- `DISCORD_LOCALE`
- `DISCORD_TIMEZONE`

ถ้าไม่กำหนด ระบบใช้ Profile สำรองที่อยู่ใน Source code ห้ามเปลี่ยนเพียงค่าเดียวแบบเดาสุ่ม เพราะ Header จะไม่สอดคล้องกัน

## การทำงาน

### One-shot

เปิด `/panel` แล้วกด `START NOW` กรอกหนึ่ง Token ต่อหนึ่งบรรทัด ระบบหยุดเองเมื่อไม่มี Quest ที่รองรับหรือเมื่อกด `STOP ALL`

### Auto Daily

ใช้ `/run` ระบบบันทึก Token แบบเข้ารหัส ตรวจทันที และตรวจเวลา 00:00 / 08:00 / 16:00 ตาม Timezone ใช้ `/stop` เพื่อหยุด

ระบบถือว่า Quest เสร็จเมื่อ Discord ส่ง `completed_at` หลังดึงข้อมูลใหม่เท่านั้น และตรวจ `claimed_at` หลัง Claim

## ฐานข้อมูล

ระบบใช้เฉพาะตาราง `scheduled_runners` สำหรับ Auto Daily เมื่อพบตาราง Tracker เก่า ระบบจะสำรองไฟล์ฐานข้อมูลก่อนแล้วจึงลบตารางเก่าอัตโนมัติ

แนะนำบน Hosting:

```env
DATABASE_PATH=/var/data/quests.db
DATABASE_BACKUP_DIR=/var/data/backups
DATABASE_BACKUP_RETENTION=7
HEALTH_STATUS_TOKEN=เปลี่ยนเป็นรหัสยาวและสุ่ม
```

## Health check

- `GET /healthz` — เปิดสาธารณะและตอบเพียง `{ "ok": true|false }`
- `GET /api/status` — รายละเอียด Runner/API ต้องส่ง `Authorization: Bearer <HEALTH_STATUS_TOKEN>`
- Slash command `/api-status` — รายละเอียดส่วนตัวภายใน Discord

## ทดสอบ

```bash
npm test
npm run check
npm audit --omit=dev --audit-level=high
```
