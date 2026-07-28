# Production Readiness Checklist

เอกสารนี้ใช้ตรวจรับ Pull Request หรือกิ่ง Release ก่อน Merge หรือ Deploy ระบบ NeverDie Quest Bot

> Automated CI ผ่านไม่เท่ากับ Discord UAT, Persistent storage UAT หรือ Multi-worker failover ผ่าน

## 1. ขอบเขตที่ต้องไม่เปลี่ยน

- [ ] Repository ยังเป็น Bot-only
- [ ] Panel มีเพียง `START NOW` และ `STOP ALL`
- [ ] Runner สูงสุด 10 บัญชีต่อ Owner
- [ ] One-shot ไม่ Persist token เพิ่ม
- [ ] Auto Daily ใช้รอบตาม Timezone ที่กำหนด
- [ ] Discord HTTP API ใช้ v10 โดยตรง
- [ ] Production lifecycle ผ่าน `quest/runner-service.js`
- [ ] ไม่มี Control Panel V2
- [ ] ไม่มี Persistent analytics/history เพิ่ม
- [ ] ไม่มี Encryption key rotation
- [ ] ไม่มี Blind retry Mutation
- [ ] PR ยังคง Draft

## 2. Environment และ Secrets

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

- [ ] `RUNNER_TOKEN_SECRET` ยาวอย่างน้อย 16 ตัวอักษรและไม่ถูก Commit
- [ ] `LOG_WEBHOOK_URL` เป็น Webhook ส่วนตัว
- [ ] `HEALTH_STATUS_TOKEN` เป็น Secret คนละค่ากับ Token อื่น
- [ ] `QUEST_PROCESS_ROLE` รับเฉพาะ `all`, `control`, `worker`
- [ ] `QUEST_WORKER_POLL_MS` อยู่ระหว่าง 1000–60000 ms
- [ ] Runtime ไม่เขียน `DATABASE_PATH` กลับ Environment
- [ ] ไม่มี `DATABASE_BACKUP_DIR`
- [ ] Client/Chrome/Electron/Build profile อัปเดตเป็นชุดเดียวกัน

## 3. Process topology

### All-in-one

- [ ] `QUEST_PROCESS_ROLE=all`
- [ ] ไม่ทำงานพร้อม Control หรือ Worker
- [ ] Scheduled runner ที่เข้า `WAITING_RETRY` ถูกปลุกโดย `all-mode-recovery.js`
- [ ] Restore Throw หรือ `restored <= 0` ถูก Rearm ด้วย Backoff
- [ ] Recovery timer ไม่เก็บ Raw user token

### Split Control + Workers

- [ ] Control และ Workers ใช้ `DATABASE_PATH` เดียวกันจริง
- [ ] ทุก Process ใช้ `RUNNER_TOKEN_SECRET` เดียวกัน
- [ ] HTTP process ใช้ Port ไม่ซ้ำ
- [ ] One-shot อยู่ Control และไม่ Delegate
- [ ] Worker ใช้ REST v10 และไม่ Login Gateway
- [ ] Scheduled row ถูก Worker รับภายใน Poll interval
- [ ] Worker แต่ละตัวมี Holder จาก PID + UUID
- [ ] Worker หลาย Holder ทำงานพร้อมกันได้
- [ ] Scheduled row มี Active claim หนึ่ง Holder
- [ ] Worker เสีย Claim แล้ว Abort local runner
- [ ] Worker อื่น Takeover ได้หลัง Claim หมดอายุ
- [ ] ไม่ใช้ Local disk แยกกันเป็น Shared topology

## 4. Bootstrap, Completion และ Shutdown

- [ ] Bootstrap handlers ติดตั้งก่อน Dynamic import
- [ ] Config/Module import failure รายงานได้โดยไม่พึ่ง SQLite/Discord Client
- [ ] Entrypoint เลือก App ตาม Process role
- [ ] Database open/migration failure ใช้ Incident code ถูกต้อง
- [ ] Runtime lease conflict/lost ทำให้ Process ปิดอย่างปลอดภัย
- [ ] Dashboard bind failure Reject startup
- [ ] Login failure ส่ง Incident แล้ว Shutdown
- [ ] Fatal/Shutdown promise ไม่ทำงานซ้อน
- [ ] Worker Mark not-ready ก่อน Shutdown
- [ ] Worker หยุด Supervisor ก่อนรับงานใหม่
- [ ] Abort runners และรอ `job.done` ก่อนปล่อย Claims
- [ ] Execution context Release ทั้ง Resolve และ Reject
- [ ] Completion observer ไม่มี Derived `unhandledRejection`
- [ ] Release callback/reporting failure ถูก Contain
- [ ] Stop/Shutdown ยกเลิก Smart Wake และ All-mode timers
- [ ] Dashboard และ Database ปิดตามลำดับ

## 5. Quest API boundary

- [ ] ใช้ `https://discord.com/api/v10`
- [ ] URL ภายนอกและ Webhook ไม่ถูก Rewrite
- [ ] Path ปฏิเสธ Authority, Query, Fragment, Backslash และ Traversal
- [ ] External Quest ID ถูก Encode เป็น segment เดียว
- [ ] Quest list ตรวจทั้งสอง Endpoint
- [ ] Endpoint แรกคืนว่างไม่ถูกสรุปทันทีว่าไม่มี Quest
- [ ] POST Mutation ไม่ Generic retry
- [ ] Abort ไม่กลายเป็น Compatibility error
- [ ] Fatal auth ถูกจัดประเภทถูกต้อง
- [ ] Video timestamp เป็นจำนวนเต็มไม่ติดลบ
- [ ] Response ปกติไม่ถูก Clone/Parse เพื่อหา Rate limit

## 6. Schema และ Executor

Target:

- [ ] Numeric string ที่ถูกต้องรับได้
- [ ] Target ต้อง Finite และมากกว่า 0
- [ ] Missing, 0, negative, `NaN`, `Infinity` → `TASK_TARGET_INVALID`

Progress:

- [ ] Numeric string ที่ถูกต้องรับได้
- [ ] Progress ต้อง Finite และไม่ติดลบ
- [ ] Invalid/negative/Infinity → `TASK_PROGRESS_INVALID`
- [ ] Progress มากกว่า Target → Percent Clamp 100
- [ ] ไม่มี `NaN` เข้า Executor, Database หรือ Status

Quest ID และ Compatibility:

- [ ] Numeric Quest ID ถูก Normalize เป็น String
- [ ] `TASK_DEFINITIONS_MISSING`, `TASK_TARGET_INVALID`, `TASK_PROGRESS_INVALID`, `MULTI_TASK_AND` เป็น Blocking
- [ ] Blocking Quest ไม่ถูกนับใน `supportedCount`
- [ ] Blocking Quest ไม่เข้าสู่ One-shot session
- [ ] Blocking Quest ไม่ส่ง Enroll, Progress, Heartbeat หรือ Claim
- [ ] Unsupported diagnostics รายงาน Compatibility code จริง

Executor ทุกตัวมี:

- [ ] `matches`
- [ ] `validate`
- [ ] `estimateDuration`
- [ ] `execute`
- [ ] `verify`
- [ ] `describeUnsupportedReason`

## 7. Durable state และ Mutation checkpoint

Scheduled runner Persist:

- [ ] State และ `state_source`
- [ ] Quest ID/name/event
- [ ] Progress และ Server progress seconds
- [ ] `next_action_at`, Retry count
- [ ] Error category และ Last error
- [ ] Mutation kind/status/payload แบบ Sanitized
- [ ] Attempted/verified timestamps
- [ ] Metadata และ Checkpoint version

Mutation lifecycle:

```text
PREPARED → IN_FLIGHT → ACCEPTED/UNCERTAIN → VERIFIED
```

ตรวจว่า:

- [ ] `PREPARED` ก่อน Request
- [ ] `IN_FLIGHT` ก่อน Network execute
- [ ] Ownership ตรวจก่อน Queue และก่อน Execute
- [ ] Checkpoint write failure หยุด Mutation
- [ ] Payload ไม่มี Token, Cookie, CAPTCHA, Webhook หรือ Full response
- [ ] Active checkpoint เขียนทับด้วย Mutation ใหม่ไม่ได้
- [ ] Fresh verification ต้องจบก่อนปลด Barrier
- [ ] Server-confirmed Mutation ไม่ถูกลดเป็น FAILED เมื่อ Persist VERIFIED ล้ม
- [ ] `PREPARED` ไม่มี Mutation kind เกิดไม่ได้

## 8. Recovery และ Stop

- [ ] Scheduled interruption → Recovery plan
- [ ] One-shot interruption → `FAILED`
- [ ] Future waiting state → รอตาม `next_action_at`
- [ ] `PREPARED/IN_FLIGHT/ACCEPTED/UNCERTAIN` → Verify ก่อน Resend
- [ ] `VERIFYING_*` → Verification ต่อ
- [ ] Recovery fetch ที่จบระหว่าง `FETCHING_QUESTS` → `WAITING_RETRY`
- [ ] Claim retry ไม่ปลุก Terminal runner
- [ ] Restore Throw → Report + Rearm
- [ ] Restore summary `restored <= 0` → Failure + Rearm
- [ ] Active schedule + Terminal checkpoint → Fresh start
- [ ] Control stop ใช้ `STOPPING` เมื่อ Worker อาจยังทำงาน
- [ ] Detached STOPPING → STOPPED เมื่อ Row/Job หายจริง

## 9. Scheduler และ Smart Wake

- [ ] Hint แยกตาม Source
- [ ] `expiresAt` ต่ออายุ Stored hint ได้
- [ ] Effective hint เป็น `baseline` → ล้าง Timer
- [ ] Effective hint เป็น `null` → ล้าง Timer
- [ ] Invalid `nextActionAt` → ล้าง Timer
- [ ] Urgent hint ใหม่แทน hint เก่าได้
- [ ] Fixed schedule ที่เร็วกว่า Hint ไม่ถูกปลุกซ้ำ
- [ ] Stop denied → ล้าง Attempt และไม่ Restart
- [ ] Replacement job → ไม่ Restart ทับ
- [ ] Scheduled row ถูกลบ → ยกเลิก Wake
- [ ] Timer ระยะไกลแบ่งช่วงไม่เกิน 24 ชั่วโมง

## 10. Durable state authority

Status observer อนุญาต:

- [ ] `NETWORK RETRY` → `WAITING_RETRY`
- [ ] `NEXT CHECK`/`AUTO DAILY ACTIVE` → `WAITING_SCHEDULE`

Status observer ห้ามเขียนทับ:

- [ ] Active mutation checkpoint
- [ ] `WAITING_ENROLLMENT`
- [ ] `WAITING_RATE_LIMIT`
- [ ] State จาก `schedule-hint:*`
- [ ] `STOPPING`, `STOPPED`, `COMPLETED`, `FAILED`

Terminal status ที่สังเกตได้ต้องชนะ Waiting state ที่ยังไม่ Terminal

## 11. Rate limit และ Circuit breaker

- [ ] บัญชีเดียวไม่ยิงพร้อมกันเกินหนึ่ง Request
- [ ] รองรับ Scope `user`, `shared`, `global`
- [ ] อ่าน Header และ JSON `retry_after`
- [ ] Server delay มากกว่า 60 วินาทีถูกเคารพเต็มจำนวน
- [ ] Response ปกติไม่เข้า Retry parsing path
- [ ] Global 429 หยุด Queue ทั้งหมด
- [ ] Authorization เป็น Fingerprint ไม่ใช่ Raw token
- [ ] Circuit มี `CLOSED`, `OPEN`, `HALF_OPEN`
- [ ] Mutation ถูก Block จน Fresh verification
- [ ] Bookkeeping failure ไม่ข้าม Circuit accounting
- [ ] Missing execution context/ownership ทำ Mutation ต่อไม่ได้

## 12. Storage, Backup และ Incident

- [ ] Storage mode รายงานตามจริง
- [ ] Backup path อยู่เฉพาะ Fixed local/persistent roots
- [ ] Retention ไม่เกิน 7 Slot
- [ ] Backup failure threshold เปิด Incident หนึ่งรายการ
- [ ] Recovery ใช้ Incident ID เดิม
- [ ] Incident ไม่ Spam Webhook
- [ ] Payload ปิด Mentions
- [ ] Context ใช้ Allowlist
- [ ] Token, Webhook, CAPTCHA และ Secret ถูก Redact
- [ ] `/api/status` ไม่แสดง Full path หรือ Secret
- [ ] Controlled restart แล้วยังพบ Database, Backup และ Scheduled rows

## 13. Automated quality gates

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

Final code evidence จาก CI #1351:

- [x] Repository shape
- [x] Sanitized Quest fixture
- [x] Fixed backup destinations
- [x] Incident/Storage boundaries
- [x] 381/381 tests
- [x] 0 failed/cancelled/skipped/todo
- [x] Coverage 93.38% lines / 84.32% branches / 88.70% functions
- [x] 26/26 critical mutations killed
- [x] Mutation source restoration
- [x] JS/MJS/Bash syntax
- [x] Production dependency audit ระดับ High

Mutation gate ครอบคลุม:

1. Fresh verification หลัง Uncertain mutation
2. Deadline ordering
3. Recovery checkpoint
4. Executor compatibility
5. Durable update enforcement
6. User-scoped bucket
7. Target validation
8. Progress validation
9. Baseline wake cleanup
10. Rejected completion release
11. All-mode state eligibility
12. Observer wait priority
13. Video timestamp validation
14. Completion observer containment
15. Completion release reporter containment
16. Terminal claim retry guard
17. Unsupported reason precedence
18. All-mode restore rearm
19. Empty restore summary
20. Hint expiry refresh
21. Header Retry-After duration
22. Body retry_after duration
23. Normal response parsing guard
24. Terminal observer precedence
25. Smart Wake denied-attempt cleanup
26. Quest ID normalization

## 14. External gates

บน Code evidence HEAD เดียวกัน:

- [x] Snyk status Success
- [x] CodeRabbit commit status Success
- [ ] CodeRabbit current review threads ถูกตอบและ Resolve ครบ
- [ ] CodeRabbit Full review หลังเอกสารรอบสุดท้าย
- [ ] Codacy current-head result
- [ ] SonarCloud current-head result

ห้ามใช้ผลจาก HEAD เก่าเป็น Final evidence

## 15. Controlled functional UAT

ใช้ Server และบัญชีทดสอบ:

- [ ] Permission ของ `/api-status`
- [ ] Start พร้อมกันไม่เกิน 10 Runner
- [ ] Stop ระหว่างทำงานและรอ Terminal จริง
- [ ] Auto Daily Restart/Restore
- [ ] All-mode transient recovery โดยไม่ Restart Process
- [ ] Restore summary `restored: 0`
- [ ] Enroll lifecycle
- [ ] Video progress พร้อม Response loss
- [ ] Desktop heartbeat พร้อม Worker claim loss
- [ ] Claim reward พร้อม Durable cooldown
- [ ] CAPTCHA และ Non-CAPTCHA HTTP 400
- [ ] HTTP 429 ที่ Retry-After มากกว่า 60 วินาที
- [ ] Restart ที่ `PREPARED`, `IN_FLIGHT`, `UNCERTAIN`, `VERIFIED`
- [ ] ไม่มี Blind duplicate mutation
- [ ] Worker claim conflict และ Takeover
- [ ] Persistent storage restart/redeploy
- [ ] Backup/Incident recovery
- [ ] Token invalid ขณะ Waiting
- [ ] Claim callback หลัง Runner Terminal
- [ ] Panel ยังมีเพียง `START NOW / STOP ALL`

## 16. Rollback

ก่อน Deploy:

- [ ] บันทึก Commit SHA
- [ ] ตรวจ Backup ล่าสุดเปิดอ่านได้
- [ ] เก็บ Environment เดิมอย่างปลอดภัย
- [ ] Split mode ใช้ SHA เดียวกันทุก Process

เมื่อพบปัญหา:

1. หยุด Deployment ใหม่
2. Mark Workers not-ready
3. หยุด Control/Workers
4. Rollback ทุก Process ไป SHA เดียวกัน
5. Restore Database เฉพาะเมื่อยืนยัน Data/Schema เสีย
6. หมุน Secret หากสงสัยว่ารั่ว
7. เพิ่ม Regression test ก่อน Deploy ใหม่

## 17. เกณฑ์อนุมัติ

Production อนุมัติได้เมื่อ:

- [ ] CI ของ HEAD ล่าสุดผ่านทั้งหมด
- [ ] Snyk, Codacy, SonarCloud และ CodeRabbit ตรวจบน HEAD เดียวกัน
- [ ] ไม่มี Current review thread ค้าง
- [ ] Persistent storage ผ่าน Controlled restart
- [ ] Discord Mutation UAT ผ่าน
- [ ] Multi-worker Shared storage และ Failover UAT ผ่าน
- [ ] Backup/Incident/Recovery ผ่าน
- [ ] Rollback path ถูกยืนยัน
- [ ] เจ้าของอนุมัติ Explicitly

PR ต้องคง Draft และห้าม Merge, Deploy, Auto-merge หรือ Ready-for-review จนข้อกำหนดครบ
