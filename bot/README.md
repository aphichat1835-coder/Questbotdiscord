# NeverDie Quest Bot — คู่มือ

## ติดตั้ง

```bash
npm ci
cp .env.example .env
npm run register
npm start
```

## Environment

- `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_GUILD_ID`, `OWNER_ID` — จำเป็น
- `RUNNER_TOKEN_SECRET` — อย่างน้อย 16 ตัวอักษรสำหรับ Auto Daily
- `TIMEZONE` — ค่าเริ่มต้น `Asia/Bangkok`
- `MANAGER_ROLE_ID` — Role ที่ใช้ Start Runner; Owner/Admin ใช้ได้เสมอ
- `LOG_CHANNEL_ID` — ห้องสำรองสำหรับสถานะและ Error
- `DATABASE_PATH` — ค่าเริ่มต้น `./data/quests.db`
- `DATABASE_BACKUP_DIR`, `DATABASE_BACKUP_RETENTION` — ระบบสำรองฐานข้อมูล
- `GITHUB_TOKEN` — เพิ่ม GitHub API rate limit สำหรับข้อมูล Discord build

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
```

## Health check

- `/healthz`
- `/api/status` ของ HTTP server
- Slash command `/api-status` สำหรับรายละเอียดภายใน Discord

## ทดสอบ

```bash
npm test
find src -name '*.js' -print0 | xargs -0 -n1 node --check
npm audit --omit=dev --audit-level=high
```
