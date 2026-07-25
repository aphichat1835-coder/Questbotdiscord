# Backend Incident Architecture

เอกสารนี้เป็นสัญญาการออกแบบสำหรับกิ่ง `aa` ระหว่างการพัฒนา และใช้คู่กับ `PRODUCTION-CHECKLIST.md`

## Core contract

- Render/Console logs เป็นหลักฐาน Error ทุกระดับ
- Discord Webhook รับเฉพาะ Structured Incident ที่มี Code จาก `incident-catalog.js`
- Incident context ใช้ Allowlist ต่อ Code ห้ามส่ง Arbitrary object
- Webhook ปิด Mentions, ปิด Redirect และไม่ Retry POST ที่มีผลการส่งไม่ชัดเจน
- เหตุซ้ำรวมด้วย `code + scope` และต้องรองรับ Recovery
- Compatibility wrapper `reportCriticalError()` เป็นของชั่วคราวจน Caller ถูกย้ายไป `reportError()`, `reportIncident()` หรือ `reportRecovery()` ครบ

## Required environment

```env
DISCORD_BOT_TOKEN=
DISCORD_CLIENT_ID=
DISCORD_GUILD_ID=
OWNER_ID=
RUNNER_TOKEN_SECRET=
LOG_WEBHOOK_URL=
```

ค่าอื่นยัง Override ได้ แต่ไม่บังคับเมื่อมี Default ที่ปลอดภัย

## Completion boundary

CI ผ่านไม่ได้ยืนยัน Webhook จริง, Render persistent disk, Discord login หรือ Live Quest mutation ต้องผ่าน Controlled UAT และ Rollback checklist ก่อน Merge/Deploy
