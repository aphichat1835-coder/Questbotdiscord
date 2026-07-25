# Backend Incident Architecture

เอกสารนี้เป็นสัญญาการออกแบบสำหรับกิ่ง `aa` และใช้คู่กับ `PRODUCTION-CHECKLIST.md`

## Core contract

- Render/Console logs เป็นหลักฐาน Error ทุกระดับ
- Discord Webhook รับเฉพาะ Structured Incident ที่มี Code จาก `incident-catalog.js`
- Incident context ใช้ Allowlist ต่อ Code ห้ามส่ง Arbitrary object
- Webhook ปิด Mentions และ Redirect
- HTTP 429/502/503/504 Retry ได้สูงสุดหนึ่งครั้ง
- Network timeout หลังเริ่ม POST ถือเป็น `delivery_unknown` และไม่ส่งซ้ำแบบเดาสุ่ม
- เหตุซ้ำรวมด้วย `code + scope` ภายใน 10 นาที
- Incident ที่กลับมาปกติส่ง Recovery ด้วย Incident ID เดิม
- `/api/status` แสดงเฉพาะสถานะการส่ง, Storage mode และ Backup health ห้ามแสดง Credential หรือ Full database path

## Safe bootstrap

`index.js` ติดตั้ง Process handlers ก่อน Dynamic import ของ Runtime modules ดังนั้น Config, Database หรือ Module import ที่ล้มยังสามารถใช้ Bootstrap reporter ซึ่งไม่พึ่ง `config.js`, SQLite หรือ Discord Client

ลำดับ Startup:

1. ติดตั้ง Bootstrap handlers
2. โหลด Runtime modules
3. เปิดฐานข้อมูลและ Migration
4. Acquire runtime lease
5. Bind Health server และรอ `listening`
6. โหลด Discord client profile
7. Login Discord
8. Start worker และ Restore runners

Fatal report มี Budget รวม 3.5 วินาทีก่อน Shutdown เพื่อไม่ให้ Process ค้างไม่สิ้นสุด

## Incident classes

### แจ้งทันที

- `DATABASE_OPEN_FAILED`
- `DATABASE_MIGRATION_FAILED`
- `RUNTIME_LEASE_CONFLICT`
- `RUNTIME_LEASE_LOST`
- `HEALTH_SERVER_BIND_FAILED`
- `DISCORD_LOGIN_FAILED`
- `DISCORD_SESSION_INVALIDATED`
- `UNCAUGHT_EXCEPTION`
- `UNHANDLED_REJECTION`
- `QUEST_API_SCHEMA_INCOMPATIBLE`

### แจ้งเมื่อผ่าน Threshold

- `BACKUP_PROTECTION_LOST`
  - Failure ติดต่อกัน 3 ครั้ง หรือ Backup เก่าเกิน 26 ชั่วโมง
  - Failure ครั้งแรกและครั้งที่สองอยู่ใน Render logs เท่านั้น
  - Retry ทุก 15 นาทีระหว่างผิดปกติ
  - ส่ง Recovery เมื่อ Backup สำเร็จอีกครั้ง
- `QUEST_API_TRANSPORT_OUTAGE`
  - ต้องพบ Transport outage 3 ครั้งภายใน 10 นาที
  - Unknown Quest event ไม่ใช่ Emergency
- `RUNNER_RESTORE_SYSTEM_FAILED`
  - รวม Restore failure 3 รายการภายใน 10 นาทีเป็น Incident เดียว
  - Context แสดงเฉพาะยอดรวมและประเภท failure

### ไม่แจ้ง Webhook

- User Token หมดอายุหรือไม่มีสิทธิ์
- Error ของบัญชีเดียว
- Unknown Quest event
- Interaction error
- Discord shard สะดุดชั่วคราว

## Storage truth

ระบบใช้ `storage-profile.js` เป็น Source of truth เดียวและไม่เขียนค่ากลับเข้า `process.env`

- `memory` — ไม่มี Durability และปิด Backup
- `local-development` — Local file สำหรับการพัฒนา
- `hosted-ephemeral` — Hosting ไม่มี Persistent mount; แสดง Warning ชัดเจน
- `persistent-candidate` — `/var/data` มีและเขียนได้ แต่ยังไม่ถือว่า Verified จนผ่าน Controlled restart

คำว่า Persistent ต้องพิสูจน์ด้วยการ Restart/Redeploy แล้ว Database และ Backup ยังอยู่ ไม่ใช้เพียงการตรวจ Directory

## Required environment

```env
DISCORD_BOT_TOKEN=
DISCORD_CLIENT_ID=
DISCORD_GUILD_ID=
OWNER_ID=
RUNNER_TOKEN_SECRET=
LOG_WEBHOOK_URL=
```

ค่าอื่นยัง Override ได้ แต่ไม่บังคับเมื่อมี Default ที่ปลอดภัย `LOG_CHANNEL_ID` ยังคง Optional สำหรับข้อความสถานะ Runner เดิม

## Compatibility boundary

`reportCriticalError()` ยังเป็น Transitional bridge สำหรับ Caller ขนาดใหญ่ใน Quest runner โดย policy ถูกย้ายไป `legacy-incident-policy.js` และมี Test ครบสำหรับ Transport/Restore threshold ทางเลือกนี้ลดความเสี่ยงจากการแทนไฟล์ Runner ทั้งก้อน และต้องถูกลบเมื่อ Caller ถูกแยกเป็นโมดูลเล็กในงานถัดไป

## Completion boundary

CI ผ่านยืนยัน Unit/Regression, Syntax, Backup destinations และ Dependency audit เท่านั้น ยังไม่ยืนยัน:

- Webhook URL จริง
- Discord login จริง
- Render persistent disk
- Restart/Restore จริง
- Live Quest Enroll/Progress/Heartbeat/Claim

ต้องผ่าน Controlled UAT และ Rollback checklist ก่อน Merge/Deploy
