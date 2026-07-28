# Production Readiness Checklist

เอกสารนี้ใช้ตรวจรับ Pull Request หรือกิ่ง Release ก่อน Merge หรือ Deploy ระบบ NeverDie Quest Bot

> CI ที่ผ่านไม่เท่ากับ Production UAT ผ่าน โดยเฉพาะ Discord Quest Mutation, All-in-one recovery และ Multi-worker failover

## 1. ขอบเขตที่ต้องไม่เปลี่ยน

- Repository ยังเป็น Bot-only
- Panel มีเพียง `START NOW` และ `STOP ALL`
- Runner สูงสุด 10 บัญชีต่อ Owner
- One-shot ไม่ Persist token เพิ่ม
- Auto Daily ใช้รอบ 00:00 / 08:00 / 16:00 ตาม Timezone
- ไม่เพิ่ม Control Panel V2
- ไม่เพิ่ม Persistent analytics/history
- ไม่เพิ่ม Encryption key rotation
- Discord HTTP API ใช้ v10 โดยตรง
- ห้าม Blind retry Mutation
- Production lifecycle ต้องผ่าน `quest/runner-service.js`

## 2. Environment

ค่าหลัก:

```env
DISCORD_BOT_TOKEN=
DISCORD_CLIENT_ID=
DISCORD_GUILD_ID=
OWNER_ID=
RUNNER_TOKEN_SECRET=
LOG_WEBHOOK_URL=
```

ค่า Optional:

```env
MANAGER_ROLE_ID=
LOG_CHANNEL_ID=
TIMEZONE=Asia/Bangkok
DISCORD_TIMEZONE=Asia/Bangkok
DISCORD_LOCALE=en-US
DATABASE_PATH=
DATABASE_BACKUP_ENABLED=
DATABASE_BACKUP_RETENTION=7
HEALTH_STATUS_TOKEN=
PORT=
QUEST_PROCESS_ROLE=all
QUEST_WORKER_POLL_MS=5000
```

ตรวจว่า:

- `RUNNER_TOKEN_SECRET` ยาวอย่างน้อย 16 ตัวอักษรและไม่ถูก Commit
- `LOG_WEBHOOK_URL` เป็น Webhook ส่วนตัว
- `HEALTH_STATUS_TOKEN` เป็น Secret คนละค่ากับ Token อื่น
- `QUEST_PROCESS_ROLE` รับเฉพาะ `all`, `control`, `worker`
- `QUEST_WORKER_POLL_MS` อยู่ระหว่าง 1000–60000 ms
- Discord profile อัปเดตพร้อมกันทั้ง Client/Chrome/Electron/Build
- Runtime ไม่เขียน `DATABASE_PATH` กลับเข้า Environment
- ไม่มี `DATABASE_BACKUP_DIR`

## 3. Process topology

### All-in-one

- `QUEST_PROCESS_ROLE=all`
- เปิด Gateway, Commands, One-shot และ Scheduled runner ใน Process เดียว
- ห้ามทำงานพร้อม Control หรือ Worker
- Scheduled runner ที่ออกระหว่าง Transient recovery ต้องถูกปลุกจาก Durable `WAITING_RETRY`
- Recovery timer ห้ามเก็บ Raw user token

### Split Control + Workers

ต้องยืนยัน:

1. Control และ Workers ใช้ `DATABASE_PATH` เดียวกันจริง
2. ทุก Process ใช้ `RUNNER_TOKEN_SECRET` เดียวกัน
3. HTTP process ใช้ Port ไม่ซ้ำ
4. One-shot อยู่ Control และไม่ Delegate
5. Worker ใช้ REST v10 และไม่ Login Gateway
6. Scheduled row ถูก Worker รับภายใน Poll interval
7. Worker แต่ละตัวมี Holder จาก PID + UUID
8. Worker หลาย Holder ทำงานพร้อมกันได้
9. Scheduled row มี Active claim ได้หนึ่ง Holder
10. Worker เสีย Claim แล้ว Abort local runner
11. Worker อื่น Takeover ได้หลัง Claim หมดอายุ
12. Local disk แยกกันห้ามใช้เป็น Shared topology

## 4. Safe bootstrap, completion และ Shutdown

ตรวจว่า:

1. Bootstrap handlers ติดตั้งก่อน Dynamic import
2. Config/Module import failure รายงานได้โดยไม่พึ่ง SQLite/Discord Client
3. Entrypoint เลือก App ตาม Process role
4. Database open/migration failure ใช้ Incident code ถูกต้อง
5. Runtime lease conflict/lost ทำให้ Process ปิดอย่างปลอดภัย
6. Dashboard bind failure Reject startup
7. Login failure ส่ง Incident แล้ว Shutdown
8. Fatal report มี Time budget
9. Fatal/Shutdown promise ไม่ทำงานซ้อน
10. Worker Mark not-ready ก่อน Shutdown
11. Worker หยุด Supervisor ก่อนรับงานใหม่
12. Abort runners และรอ `job.done` ก่อนปล่อย Claims
13. Execution context ถูก Release ทั้งเมื่อ `job.done` Resolve และ Reject
14. Derived completion promise ไม่มี `unhandledRejection`
15. Release callback failure ถูกจับและไม่ปิด Process
16. Release error reporter ที่โยนซ้ำต้องถูก Contain
17. Completion observer transition failure ถูก Report และไม่หลุดจาก Promise chain
18. Observer cleanup `.finally()` ไม่สร้าง `unhandledRejection`
19. Stop/Shutdown ยกเลิก Smart Wake และ All-mode recovery timers
20. Dashboard และ Database ถูกปิดตามลำดับ

## 5. Quest API boundary

ตรวจว่า:

- ใช้ `https://discord.com/api/v10` โดยตรง
- URL ภายนอกและ Webhook ไม่ถูก Rewrite
- URL path ปฏิเสธ Authority, Query, Fragment, Backslash และ Traversal
- External Quest ID ถูก Encode เป็น Path segment เดียว
- Quest list ตรวจ `/quests/@me` และ `/users/@me/quests`
- รายการว่างจาก Endpoint แรกไม่ถูกสรุปทันทีว่าไม่มี Quest
- POST Mutation ไม่ Generic retry
- Abort ไม่กลายเป็น Compatibility error
- `DiscordApiError` และ `QuestCompatibilityError` มี Source เดียว
- Video timestamp ต้องเป็นจำนวนเต็มไม่ติดลบ
- Video timestamp ที่ผิดถูก Reject ก่อน Network
- ไม่มี Video timestamp jitter ที่ไม่มีผลจริง

## 6. Schema และ Executor boundary

ตรวจ Target:

- Numeric string ที่ถูกต้องรับได้
- Target ต้อง Finite และมากกว่า 0
- Missing, 0, negative, `NaN`, `Infinity` → `TASK_TARGET_INVALID`

ตรวจ Progress:

- Numeric string ที่ถูกต้องรับได้
- Progress ต้อง Finite และไม่ติดลบ
- Invalid/negative/Infinity → `TASK_PROGRESS_INVALID`
- Progress มากกว่า Target → Percent Clamp 100
- ห้าม `NaN` เข้า Executor, Database หรือ Status

Blocking compatibility issues:

- `TASK_DEFINITIONS_MISSING`
- `TASK_TARGET_INVALID`
- `TASK_PROGRESS_INVALID`
- `MULTI_TASK_AND`

Quest ที่มี Blocking issue ต้อง:

- ไม่ถูกนับใน `supportedCount`
- ไม่เข้าสู่ One-shot session
- ไม่ถูก Automatic executor เลือก
- ไม่ส่ง Enroll, Progress, Heartbeat หรือ Claim
- ยังปรากฏใน Compatibility diagnostics

Executor ทุกตัวต้องมี:

- `matches`
- `validate`
- `estimateDuration`
- `execute`
- `verify`
- `describeUnsupportedReason`

## 7. Durable state และ Mutation checkpoint

Scheduled runner ต้อง Persist:

- State และ `state_source`
- Quest ID/name/event
- Progress และ Server progress seconds
- `next_action_at`, Retry count
- Error category และ Last error
- Mutation kind/status/payload แบบ Sanitized
- Attempted/verified timestamps
- Checkpoint version

Mutation lifecycle:

```text
PREPARED → IN_FLIGHT → ACCEPTED/UNCERTAIN → VERIFIED
```

ตรวจว่า:

1. `PREPARED` ก่อน Request
2. `IN_FLIGHT` ก่อน Network execute
3. Ownership ตรวจก่อน Queue และก่อน Execute
4. Checkpoint write failure หยุด Mutation
5. Payload ไม่มี Token, Cookie, CAPTCHA, Webhook หรือ Full response
6. Active checkpoint เขียนทับด้วย Mutation ใหม่ไม่ได้
7. Fresh verification ต้องจบก่อนปลด Barrier
8. Server-confirmed Mutation ไม่ถูกลดเป็น FAILED เมื่อเขียน VERIFIED ล้ม
9. `PREPARED` ไม่มี Mutation kind เกิดไม่ได้

## 8. Recovery และ Stop

ตรวจว่า:

- Scheduled interruption → Recovery plan
- One-shot interruption → `FAILED`
- Waiting state อนาคต → รอตาม `next_action_at`
- `PREPARED/IN_FLIGHT/ACCEPTED/UNCERTAIN` → Verify ก่อน Resend
- `VERIFYING_*` → Verification ต่อ
- Active schedule + Terminal checkpoint → Fresh start
- Claim cooldown อยู่รอดหลัง Restart
- Control stop ตั้ง `STOPPING` เมื่อ Worker อาจยังทำงาน
- Worker Abort เมื่อ Row หายหรือ Ownership หลุด
- `STOPPING` คงอยู่จน `job.done` settle
- Detached STOPPING → STOPPED เมื่อไม่มี Row/Job จริง

### All-mode delayed recovery

ก่อน Restore ต้องตรวจซ้ำ:

1. Process role ยังเป็น `all`
2. Mode เป็น Scheduled
3. Durable state ยัง `WAITING_RETRY`
4. `schedule_id` ตรงกัน
5. Scheduled row ยังอยู่
6. ไม่มี Replacement job
7. ถึง `next_action_at` แล้ว
8. Token ถูก Decrypt จาก Store ตอน Restore ไม่ถูกเก็บใน Timer

## 9. Scheduler และ Smart Wake

ตรวจว่า:

- Hint แยกตาม Source
- Baseline ลบ Urgent source ไม่ได้
- Effective hint กลับเป็น `baseline` → ล้าง Timer เก่า
- Effective hint เป็น `null` → ล้าง Timer
- Invalid `nextActionAt` → ล้าง Timer เก่า
- Urgent A ถูกแทนด้วย Urgent B → ทำงานเฉพาะ B
- Fixed schedule ที่เร็วกว่า Hint ไม่ถูกปลุกซ้ำ
- Stop denied → ไม่ Restart
- Replacement job ระหว่าง Cleanup → ไม่ Restart ทับ
- Scheduled row ถูกลบ → ยกเลิก Wake
- Timer ระยะไกลแบ่งช่วงไม่เกิน 24 ชั่วโมง

## 10. Durable state authority

Status observer อนุญาต:

- `NETWORK RETRY` → `WAITING_RETRY`
- `NEXT CHECK`/`AUTO DAILY ACTIVE` → `WAITING_SCHEDULE`

Status observer ห้ามเขียนทับ:

- Active mutation checkpoint
- `WAITING_ENROLLMENT`
- `WAITING_RATE_LIMIT`
- State จาก `schedule-hint:*`
- `STOPPING`, `STOPPED`, `COMPLETED`, `FAILED`

`next_action_at` ต้องตรงกับเวลาที่ Runner กำลัง Sleep จริง

## 11. Rate limit และ Circuit breaker

ตรวจว่า:

- บัญชีเดียวไม่ยิงพร้อมกันเกินหนึ่ง Request
- รองรับ Scope `user`, `shared`, `global`
- อ่าน Header และ JSON `retry_after`
- Global 429 หยุด Queue ทั้งหมด
- Authorization เป็น Fingerprint ไม่ใช่ Raw token
- Circuit มี `CLOSED`, `OPEN`, `HALF_OPEN`
- Mutation ถูก Block จน Fresh verification
- Bookkeeping failure ไม่ข้าม Circuit accounting
- Missing execution context/ownership ทำ Mutation ต่อไม่ได้

## 12. Claim retry

ตรวจ Class:

- CAPTCHA evidence จริง → Long cooldown
- Ambiguous platform → Long cooldown
- Generic HTTP 400 → `REQUEST_REJECTED`
- HTTP 429 → `RATE_LIMITED`
- Verification absent → Standard cooldown
- Network/5xx → Temporary error

ห้าม Generic HTTP 400 ถูกเหมารวมเป็น CAPTCHA

## 13. Storage, Backup และ Incident

ตรวจว่า:

- Storage mode รายงานตามจริง
- Backup path อยู่เฉพาะ Fixed local/persistent roots
- Retention ไม่เกิน 7 Slot
- Backup failure threshold เปิด Incident หนึ่งรายการ
- Recovery ใช้ Incident ID เดิม
- Incident ไม่ Spam Webhook
- Payload ปิด Mentions
- Context ใช้ Allowlist
- Token, Webhook, CAPTCHA และ Secret ถูก Redact
- `/api/status` ไม่แสดง Full path หรือ Secret
- Controlled restart แล้วยังพบ Database, Backup และ Scheduled rows

## 14. API status และ Health

ตรวจว่า:

- `/api-status` ใช้ได้เฉพาะ Owner/Admin/Manager
- HTTP `/api/status` ปิดเมื่อไม่มี `HEALTH_STATUS_TOKEN`
- ใช้ Exact Bearer token
- Public `/healthz` เปิดเผยเฉพาะ `{ ok }`
- Worker 503 ระหว่าง Bootstrap และ 200 เมื่อ Supervisor พร้อม
- Status แสดง Queue, Scope, Circuit, Checkpoint, Workers และ Claims
- Status ไม่แสดง Identifier/Token/Ciphertext/Full path

## 15. Legacy compatibility boundary

- Production entrypoint และ Commands Import `quest/runner-service.js`
- ห้าม Production import Legacy `restoreScheduledRunners` จาก `discord-runner.js`
- `speedMultiplier` ไม่มี Production caller
- ห้ามเพิ่ม Caller ใหม่
- Compatibility cleanup ภายใน Runner ใหญ่ต้องแยก Refactor ไม่ปนกับ Correctness release

## 16. Quality gates

รันจากโฟลเดอร์ `bot`:

```bash
npm ci --ignore-scripts --no-fund --no-audit
npm rebuild better-sqlite3 --foreground-scripts
npm run validate:quest-fixture
npm test
npm run test:coverage
npm run test:mutation-safety
npm run check
npm audit --omit=dev --audit-level=high
git diff --exit-code
```

GitHub Actions ต้องผ่านบน HEAD ล่าสุด:

- Repository shape
- Sanitized Quest fixture
- Fixed backup destinations
- Incident/Storage boundaries
- Full recursive tests
- Coverage gate
- Critical mutation gate 15 ตัว
- Source restoration หลัง Mutation
- JS/MJS/Bash syntax
- Production dependency audit ระดับ High

Mutation gate ต้องฆ่าครบ:

1. Uncertain mutation skips verification
2. Expired deadline comparison กลับด้าน
3. Recovery ignores uncertain checkpoint
4. Incompatible Quest เข้า Automatic executor
5. Explicit checkpoint update ถูก Ignore
6. User-scoped bucket ถูก Bypass
7. Invalid target ถูกยอมรับ
8. Invalid progress ถูกยอมรับ
9. Baseline ไม่ล้าง Smart Wake
10. Rejected completion ไม่ Release context
11. All-mode recovery ทำงานนอก WAITING_RETRY
12. Observer เขียนทับ High-priority wait
13. Malformed video timestamp ถึง Network
14. Completion observer transition failure หลุดจาก Promise chain
15. Completion release error reporter สร้าง Rejection ซ้ำ

## 17. Controlled functional UAT

ใช้ Server และบัญชีทดสอบ:

1. Permission ของ `/api-status`
2. Start พร้อมกันไม่เกิน 10 Runner
3. Stop ระหว่างทำงานและรอ Terminal จริง
4. Auto Daily Restart/Restore
5. All-mode transient recovery โดยไม่ Restart Process
6. Enroll lifecycle
7. Video progress พร้อม Response loss
8. Desktop heartbeat พร้อม Worker claim loss
9. Claim reward พร้อม Durable cooldown
10. CAPTCHA และ Non-CAPTCHA HTTP 400
11. Restart ที่ `PREPARED`, `IN_FLIGHT`, `UNCERTAIN`, `VERIFIED`
12. ไม่มี Blind duplicate mutation
13. Worker claim conflict และ Takeover
14. Persistent storage restart/redeploy
15. Backup/Incident recovery
16. Panel ยังมีเพียง `START NOW / STOP ALL`

## 18. Rollback

ก่อน Deploy:

- บันทึก Commit SHA
- ตรวจ Backup ล่าสุดเปิดอ่านได้
- เก็บ Environment เดิมอย่างปลอดภัย
- Split mode ใช้ SHA เดียวกันทุก Process

เมื่อพบปัญหา:

1. หยุด Deployment ใหม่
2. Mark Workers not-ready
3. หยุด Control/Workers
4. Rollback ทุก Process ไป SHA เดียวกัน
5. Restore Database เฉพาะเมื่อยืนยัน Data/Schema เสีย
6. หมุน Secret หากสงสัยว่ารั่ว
7. เพิ่ม Regression test ก่อน Deploy ใหม่

## 19. เกณฑ์อนุมัติ

อนุมัติ Production ได้เมื่อ:

- CI ของ HEAD ล่าสุดผ่านทั้งหมด
- Snyk, Codacy, SonarCloud และ CodeRabbit ถูกตรวจบน HEAD เดียวกัน
- ไม่มี Review thread ที่ยังใช้ได้ค้าง
- Persistent storage ผ่าน Controlled restart
- Discord Mutation UAT ผ่าน
- Multi-worker Shared store และ Failover UAT ผ่าน
- Backup/Incident/Recovery ผ่าน
- Rollback path ถูกยืนยัน
- ผู้ดูแลอนุมัติ Explicitly

PR ต้องคง Draft และห้าม Merge/Deploy จนข้อกำหนดนี้ครบ
