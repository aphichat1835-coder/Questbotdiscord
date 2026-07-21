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

Runner ใช้ Client profile กลางหนึ่งชุดที่ข้อมูลสอดคล้องกัน ไม่ดึง Discord build แล้วนำไปผสมกับ Electron รุ่นทั่วไป ค่าต่อไปนี้เป็น Optional override และต้องตรวจสอบหรืออัปเดตพร้อมกันเป็นชุด:

- `DISCORD_CLIENT_VERSION`
- `DISCORD_CHROME_VERSION`
- `DISCORD_ELECTRON_VERSION`
- `DISCORD_BUILD_NUMBER`
- `DISCORD_NATIVE_BUILD_NUMBER`
- `DISCORD_LOCALE`
- `DISCORD_TIMEZONE`

ถ้าไม่กำหนด ระบบใช้ Profile สำรองที่อยู่ใน Source code ห้ามเปลี่ยนเพียงค่าเดียวแบบเดาสุ่ม เพราะ Header จะไม่สอดคล้องกัน ระบบไม่ได้สุ่มหรือพยายามเลียนแบบอุปกรณ์ของแต่ละบัญชี

## การทำงาน

### One-shot

เปิด `/panel` แล้วกด `START NOW` กรอกหนึ่ง Token ต่อหนึ่งบรรทัด ระบบหยุดเองเมื่อไม่มี Quest ที่รองรับหรือเมื่อกด `STOP ALL`

### Auto Daily

ใช้ `/run` ระบบบันทึก Token แบบเข้ารหัส ตรวจทันที และตรวจเวลา 00:00 / 08:00 / 16:00 ตาม Timezone ใช้ `/stop` เพื่อหยุด

ระบบถือว่า Quest เสร็จเมื่อ Discord ส่ง `completed_at` หลังดึงข้อมูลใหม่เท่านั้น และตรวจ `claimed_at` หลัง Claim

### สถานะหลายบัญชี

Quest API status ถูกเก็บแยกตาม Job/Account ไม่ใช้ค่ากลางก้อนเดียวร่วมกัน:

- `/api-status` แสดงสรุปรวมและสถานะบัญชีของผู้ใช้คำสั่ง
- HTTP `/api/status` แสดง `questApi.aggregate` และ `questApi.accounts`
- Status ไม่มี Token, Ciphertext หรือข้อมูลลับ
- สถานะที่หยุดแล้วถูกเก็บเป็นประวัติล่าสุดแบบจำกัดจำนวน ไม่เติบโตไม่สิ้นสุด

### Retry ของคำสั่งที่เปลี่ยนข้อมูล

Enroll, Claim, Video Progress และ Heartbeat ไม่ถูก Retry แบบสุ่ม เมื่อเกิด Network error, Timeout, HTTP 429 หรือ 5xx ระบบจะ:

1. ดึง Quest state ล่าสุดจาก Discord
2. ถ้าสถานะเปลี่ยนแล้ว ถือว่าคำขอแรกสำเร็จและไม่ส่งซ้ำ
3. ถ้ายังไม่เปลี่ยน จึงรอตาม Retry delay และส่งซ้ำได้อีกเพียงหนึ่งครั้ง
4. HTTP 4xx แบบแน่นอน เช่น 400 ไม่ถูก Retry

## ฐานข้อมูล

ระบบใช้เฉพาะตาราง `scheduled_runners` สำหรับ Auto Daily เมื่อพบตาราง Tracker เก่า ระบบจะสำรองไฟล์ฐานข้อมูลก่อนแล้วจึงลบตารางเก่าอัตโนมัติ การสำรองรายวันใช้ Slot คงที่ใน `bot/data/backups` สูงสุด 7 ไฟล์ จึงไม่รับ Path จาก Environment และไม่สะสมไฟล์ไม่สิ้นสุด

แนะนำบน Hosting:

```env
DATABASE_PATH=/var/data/quests.db
DATABASE_BACKUP_ENABLED=true
DATABASE_BACKUP_RETENTION=7
HEALTH_STATUS_TOKEN=เปลี่ยนเป็นรหัสยาวและสุ่ม
```

## Health check

- `GET /healthz` — เปิดสาธารณะและตอบเพียง `{ "ok": true|false }`
- `GET /api/status` — รายละเอียด Runner/API ต้องส่ง `Authorization: Bearer <HEALTH_STATUS_TOKEN>`
- Slash command `/api-status` — รายละเอียดส่วนตัวภายใน Discord

## Sanitized Quest schema fixture

ไฟล์ `fixtures/quest-api.sample.json` เป็นตัวอย่างโครงสร้าง Quest ที่ไม่มี Token, Cookie, Email หรือข้อมูลบัญชีจริง CI บังคับให้ไฟล์นี้มีอยู่และ Parser ต้องอ่าน Video, Game และ Completed Quest ได้

```bash
npm run validate:quest-fixture
```

CI จะล้มเมื่อ Fixture หาย, โครงสร้างหลักเสีย, Parser อ่านไม่ได้ หรือ Fixture มีชื่อฟิลด์ข้อมูลลับที่ห้ามเก็บ

## Read-only Quest API smoke test

Smoke test ตรวจบัญชีและดึงรายการ Quest จริงเท่านั้น ไม่ Enroll, ไม่ส่ง Progress, ไม่ Heartbeat และไม่ Claim

รันในเครื่องโดยส่ง Token ผ่าน Environment เท่านั้น:

```bash
DISCORD_USER_TOKEN='ใส่ใน Environment เท่านั้น' npm run smoke:quest
```

กำหนด `EXPECTED_DISCORD_ACCOUNT_ID` เพิ่มได้เพื่อป้องกันใช้ Token ผิดบัญชี ห้ามใส่ Token ในไฟล์, Commit, Log หรือคำสั่งที่ถูกบันทึกในประวัติ Shell

GitHub Actions มี Workflow `Quest API smoke` แบบกดรันด้วยตนเอง โดยอ่าน Secrets:

- `DISCORD_USER_TOKEN`
- `EXPECTED_DISCORD_ACCOUNT_ID` — ไม่บังคับ แต่แนะนำ

## ทดสอบ

```bash
npm run validate:quest-fixture
npm test
npm run check
npm audit --omit=dev --audit-level=high
```
