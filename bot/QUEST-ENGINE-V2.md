# Quest Engine V2

เอกสารนี้อธิบายชั้นระบบที่เพิ่มขึ้นโดยไม่เปลี่ยน UX ของ `/panel`, `/run` และ `/stop`

## เป้าหมาย

- บังคับ HTTP API ของ Discord เป็น v10
- ประสาน Rate limit รวมหลายบัญชีโดยไม่เก็บ Token ใน Queue state
- เก็บ Runner checkpoint ลง SQLite เพื่อให้ตรวจสอบและกู้คืนหลัง Restart ได้
- ปลุก Scheduled Runner ก่อนรอบ 00:00 / 08:00 / 16:00 เมื่อ Quest มี Deadline หรือ Enrollment เปิดก่อน
- แยกความรับผิดชอบออกจาก `discord-runner.js` แบบค่อยเป็นค่อยไป โดยรักษา Export และพฤติกรรมเดิม

## โครงสร้าง

```text
src/quest/
├─ discord-api-runtime.js      บังคับ v10 และติดตั้ง Transport
├─ rate-limit-coordinator.js   Queue ต่อบัญชี/Route/Bucket และ Global 429
├─ executors.js                Registry ของ Video/Desktop/Unsupported
├─ smart-scheduler.js          เลือกเวลาทำงานจาก Claim, Deadline, Enrollment และ Retry
├─ schedule-hint-bus.js        ส่ง Wake-up hint โดยใช้ Authorization fingerprint
├─ runner-state-store.js       Durable state machine ใน SQLite
├─ runner-state-observer.js    แปลงสถานะ Live Runner เป็น Checkpoint
└─ runner-service.js           Facade สำหรับ Start/Restore/Stop และ Smart wake
```

## API v10

`discord-api-runtime.js` ครอบ `globalThis.fetch` เฉพาะ URL ที่ขึ้นต้นด้วย `https://discord.com/api/v*` แล้วเปลี่ยน Version เป็น v10 ก่อนส่งจริง URL อื่น เช่น Webhook หรือบริการภายนอกจะไม่ถูกเปลี่ยน

Engine เดิมยังประกอบ URL v9 อยู่เพื่อรักษา Diff ให้เล็ก แต่ไม่มี Request นั้นออกจาก Process หลัง Runtime ถูกติดตั้งใน `app.start()`

## Global Rate-limit Coordinator

Coordinator ใช้ SHA-256 fingerprint 16 ตัวจาก Authorization เพื่อแยกบัญชี โดยไม่เก็บ Token ใน Queue metadata

กฎหลัก:

- บัญชีเดียวกันมี Request ทำงานพร้อมกันได้สูงสุด 1 รายการ
- หลายบัญชีทำงานพร้อมกันได้ตาม Global concurrency
- จดจำ `X-RateLimit-Bucket`
- เคารพ `X-RateLimit-Remaining`, `X-RateLimit-Reset-After`, `Retry-After`
- เมื่อได้รับ Global 429 จะหยุด Queue ทั้งหมดจนถึงเวลาที่กำหนด
- Claim และ Verification มี Priority สูงกว่า Background requests

## Durable Runner State

ตาราง `runner_states` เก็บ:

- `job_key`, Owner, Account, Mode และ Schedule ID
- State ปัจจุบัน
- Quest ID/ชื่อ/Progress ที่สังเกตล่าสุด
- `next_action_at`, Retry count และ Error ล่าสุด
- Metadata ที่ไม่มี Token

State สำคัญ:

```text
QUEUED → AUTHENTICATING → RUNNING
RUNNING → ENROLLING → RUNNING_PROGRESS → VERIFYING_COMPLETION → CLAIMING
RUNNING → WAITING_RETRY | WAITING_ENROLLMENT | WAITING_SCHEDULE
ทุก State → STOPPING → STOPPED
ทุก State → FAILED
Restart ระหว่างทำงาน → RECOVERING
```

เมื่อ Process เริ่มใหม่ State ที่ไม่จบจะถูกเปลี่ยนเป็น `RECOVERING` ก่อน Restore Scheduled Runner ผ่าน `runner-service.js`

## Smart Scheduler

Response ของ Quest list ถูกอ่านผ่าน `response.clone()` จึงไม่แย่ง Body จาก Engine เดิม ระบบสร้าง Hint จาก:

1. Completed แต่ยังไม่ Claim
2. Quest เหลือเวลาน้อยกว่า 30 นาที
3. Verification/Retry ถึงเวลา
4. Enrollment block หมด
5. Quest เริ่มได้
6. รอบตรวจพื้นฐาน

เมื่อ Hint เร็วกว่ารอบที่ Runner กำลังรอ และ Runner อยู่ในสถานะหลับ (`AUTO DAILY ACTIVE` หรือ `NEXT CHECK`) Runner service จะ:

1. หยุด Job โดยไม่ลบ Scheduled row
2. รอ Cleanup เดิมจบ
3. เริ่ม Job เดิมใหม่ทันที
4. Fetch สถานะ Quest สดจาก Discord ก่อน Mutation ตามกลไกเดิม

ระบบไม่ปลุก Runner กลางการส่ง Progress เพื่อหลีกเลี่ยงการตัด Mutation ที่กำลัง Verify

## Compatibility

- Panel เดิมไม่เปลี่ยน
- `/run`, `/stop`, `/api-status` ใช้ Runner service
- `discord-runner.js` ยังเป็น Legacy engine ภายในชั่วคราว
- Executor registry ถูกแยกแล้วเพื่อรองรับการย้าย Video/Desktop implementation ออกเป็นราย Module ในรอบถัดไปโดยไม่เปลี่ยน Contract

## Validation

Test ใหม่ครอบคลุม:

- v9 URL ถูกส่งจริงเป็น v10
- URL ภายนอกไม่ถูก Rewrite
- บัญชีเดียวไม่ยิง Request พร้อมกัน
- Global 429 หยุด Queue
- Durable state และ Restart recovery
- Deadline/Enrollment/Claim priority
- Executor registry
- Architecture boundary ว่าคำสั่งและ Lifecycle ต้องผ่าน Runner service
