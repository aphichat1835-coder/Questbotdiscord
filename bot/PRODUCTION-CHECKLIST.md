# Production Readiness Checklist

เอกสารนี้ใช้ตรวจรับ Pull Request หรือกิ่ง Release ก่อน Merge หรือ Deploy ระบบ NeverDie Quest Bot

> CI ที่ผ่านไม่เท่ากับ Production UAT ผ่าน โดยเฉพาะ Discord Quest Mutation และ Multi-worker failover

## 1. ขอบเขตที่ต้องไม่เปลี่ยน

- Repository ยังเป็น Bot-only ไม่มี Desktop/Tauri/CDP/Game Simulator
- Discord panel ยังมีเพียง `START NOW` และ `STOP ALL`
- Runner สูงสุด 10 บัญชีต่อ Owner
- One-shot ไม่ Persist token เพิ่มและหยุดเองเมื่อไม่มี Quest ที่รองรับ
- Auto Daily ยังใช้รอบ 00:00 / 08:00 / 16:00 ตาม Timezone ที่กำหนด
- ไม่เพิ่ม Control Panel V2
- ไม่เพิ่ม Persistent analytics/history
- ไม่เพิ่ม Encryption key rotation
- Discord HTTP API ใช้ v10 โดยตรง
- ห้าม Blind retry Mutation

## 2. Environment

ค่าหลักที่ต้องตั้งทุก Process:

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

- `RUNNER_TOKEN_SECRET` ยาวอย่างน้อย 16 ตัวอักษร เป็น Secret แบบสุ่ม และไม่ถูก Commit
- `LOG_WEBHOOK_URL` เป็น Discord HTTPS Incoming Webhook ส่วนตัว
- `HEALTH_STATUS_TOKEN` เมื่อเปิดใช้เป็น Secret คนละค่ากับ Token อื่น
- `QUEST_PROCESS_ROLE` รับเฉพาะ `all`, `control`, `worker`
- `QUEST_WORKER_POLL_MS` อยู่ระหว่าง 1000–60000 ms
- Discord client profile ถูกอัปเดตพร้อมกันทั้ง Client/Chrome/Electron/Build
- Runtime ไม่เขียนค่าอัตโนมัติกลับเข้า `process.env.DATABASE_PATH`
- ไม่มีการใช้ `DATABASE_BACKUP_DIR`

## 3. Process topology

### All-in-one

- ใช้ `QUEST_PROCESS_ROLE=all`
- เปิด Gateway, Commands, One-shot และ Scheduled runner ใน Process เดียว
- เหมาะกับ Single-service deployment
- ต้องไม่ทำงานพร้อม Control หรือ Worker ใด ๆ

### Split Control + Workers

Control:

```env
QUEST_PROCESS_ROLE=control
PORT=3000
```

Worker แต่ละตัว:

```env
QUEST_PROCESS_ROLE=worker
PORT=<พอร์ตที่ไม่ซ้ำ>
```

ต้องยืนยัน:

1. Control และ Workers ทุกตัวใช้ `DATABASE_PATH` เดียวกันจริง
2. ทุก Process ใช้ `RUNNER_TOKEN_SECRET` เดียวกัน
3. แต่ละ HTTP process ใช้ Port ไม่ซ้ำ
4. One-shot อยู่ Control และไม่ถูก Delegate
5. Worker ใช้ Discord REST v10 และไม่ Login Gateway
6. Scheduled row จาก Control ถูก Worker รับภายใน Poll interval
7. Worker แต่ละตัวมี Runtime holder จาก PID + UUID
8. Worker หลาย Holder ทำงานพร้อมกันได้
9. Scheduled row หนึ่งแถวมี Active ownership claim ได้เพียง Worker เดียว
10. Worker ที่เสีย Claim ต้อง Abort local runner
11. Worker อื่นรับช่วงได้หลัง Claim หมดอายุ
12. `all` ชนกับ `control`/`worker`
13. Control ซ้ำด้วย Holder คนละตัวถูกปฏิเสธ
14. Deployment ที่แต่ละ Service มี Local disk แยกกันห้ามใช้ Split mode
15. `/api-status` แสดงจำนวน Worker holders และ Scheduled claims โดยไม่เปิดเผย Secret

## 4. Safe bootstrap และ Shutdown

ตรวจว่า:

1. Bootstrap handlers ติดตั้งก่อน Dynamic import ของ Config/Runtime
2. Config/Module import failure ถูกบันทึกโดยไม่พึ่ง SQLite หรือ Discord Client
3. Entrypoint เลือก Control app หรือ Worker app ตาม Role
4. Database open failure ใช้ `DATABASE_OPEN_FAILED`
5. Schema/migration failure ใช้ `DATABASE_MIGRATION_FAILED`
6. Topology lease conflict/lost ทำให้ Process ปิดอย่างปลอดภัย
7. Health server bind failure Reject startup
8. Control/All login failure ส่ง Incident แล้ว Shutdown
9. Worker ไม่ Login Gateway
10. Fatal report ใช้ Budget จำกัด
11. Fatal promise และ Shutdown promise ไม่ทำงานซ้อน
12. Signal ปกติชน Fatal errorต้องรักษา Exit code ที่รุนแรงที่สุด
13. Worker Mark not-ready ก่อน Shutdown
14. Worker หยุด Supervisor ก่อนรับงานใหม่
15. Worker Abort local runners และรอ `job.done` settle ก่อนปล่อย Claims
16. Dashboard ที่กำลัง Bind ถูกปิด ไม่ทิ้ง Server ไม่มีเจ้าของ

## 5. Quest API และ Schema

ตรวจว่า:

- Source ใช้ `https://discord.com/api/v10` โดยตรง
- URL ภายนอกและ Webhook ไม่ถูก Rewrite
- `Request` object รักษา Method/Headers/Body
- Quest list ตรวจ `/quests/@me` และ Fallback `/users/@me/quests`
- รายการว่างจาก Endpoint แรกไม่ถูกสรุปทันทีว่าไม่มี Quest
- รองรับ `task_config_v2` และ Legacy `task_config`
- Multi-task `join_operator=and` ไม่ถูกทำอัตโนมัติแบบ Task เดียว
- Unknown event ถูกจัดเป็น Compatibility issue
- Abort ไม่ถูกบันทึกเป็น Schema failure
- `QuestCompatibilityError` ใช้ Class เดียวทั้ง API/Schema/Runner
- Malformed payload เปลี่ยนสถานะเป็น `incompatible` และส่ง Structured incident

## 6. Executor plugins

Executor ทุกตัวต้องมี:

- `matches`
- `validate`
- `estimateDuration`
- `execute`
- `verify`
- `describeUnsupportedReason`

ตรวจว่า:

- Video loop อยู่ใน Video executor
- Desktop heartbeat loop อยู่ใน Desktop executor
- Registry เป็น Source of truth สำหรับ Event support
- Unsupported และ Unknown Quest ไม่ส่ง Progress mutation
- Completion ต้องผ่าน Fresh verification
- Executor ไม่เข้าถึง Raw token โดยไม่จำเป็น

## 7. Durable state และ Mutation checkpoint

Scheduled runner ต้อง Persist:

- State, Quest ID/name/event
- Progress และ Server progress seconds
- `next_action_at` และ Retry count
- Error category และ Last error
- Mutation kind/status/payload แบบ Sanitized
- Attempted/verified timestamps
- State source และ Checkpoint version

Mutation kind:

- `ENROLL`
- `VIDEO_PROGRESS`
- `HEARTBEAT`
- `CLAIM`

Mutation status:

- `NONE`
- `PREPARED`
- `IN_FLIGHT`
- `ACCEPTED`
- `UNCERTAIN`
- `VERIFIED`
- `FAILED`

ตรวจว่า:

1. `PREPARED` ต้อง Persist ก่อนส่ง Request
2. `IN_FLIGHT` ต้อง Persist ก่อน Network execute
3. Ownership ถูกตรวจทั้งก่อน Queue และก่อน Network execute
4. Checkpoint write failure หยุด Mutation/Retry
5. Payload ไม่มี Token, Cookie, CAPTCHA, Webhook URL หรือ Full response
6. Partial transition รักษาค่าที่ไม่ได้ส่งใหม่
7. Explicit `null` เคลียร์ Optional field ได้
8. Direct state source มีอำนาจเหนือข้อความ UI

## 8. Recovery และ Stop

ตรวจว่า:

- Scheduled interruption → `RECOVERING`
- One-shot interruption → `FAILED`
- Waiting state ที่ยังไม่ถึงเวลา → รอตาม `next_action_at`
- `PREPARED/IN_FLIGHT/ACCEPTED/UNCERTAIN` → Verify Server ก่อนส่งซ้ำ
- Crash ที่ State ยัง `RUNNING` แต่ Mutation เป็น `UNCERTAIN` → `VERIFY_MUTATION`
- State `VERIFYING_*` → ทำ Verification ต่อ
- `VERIFYING_COMPLETION` → ตรวจ Completion ต่อ
- Active schedule ที่มี Terminal checkpoint → เริ่มจาก Fresh state
- Orphaned recovering state → `FAILED`
- Restore จำกัด 10 Runner ต่อ Owner
- Restore ไม่ถือ `account_id=null` หลายแถวเป็นบัญชีเดียว
- Claim retry cooldown อยู่รอดหลัง Restart
- Control stop ตั้ง `STOPPING` เมื่อ Worker อาจยังทำงาน
- Worker Abort เมื่อ Scheduled row หายหรือ Ownership หลุด
- `STOPPING` คงอยู่จน `job.done` settle
- Detached `STOPPING` เปลี่ยนเป็น `STOPPED` เมื่อ row/job หายจริง
- `/stop` รายงาน Pending เมื่อ Terminal confirmation ยังไม่มา
- Smart wake restart ไม่ลบ Scheduled row

## 9. Rate limit, Circuit breaker และ Scheduler

ตรวจว่า:

- บัญชีเดียวไม่ยิงพร้อมกันเกินหนึ่ง Request
- รองรับ Scope `user`, `shared`, `global`
- Global 429 หยุด Queue ทั้งหมด
- อ่านทั้ง Header และ JSON `retry_after`
- Bucket timer ตื่นตามเวลาที่เร็วที่สุด
- Claim/Verification มี Priority สูงกว่า Background
- Authorization ใน Queue เป็น Fingerprint ไม่ใช่ Raw token
- Circuit breaker มี `CLOSED`, `OPEN`, `HALF_OPEN`
- Half-open อนุญาต Probe ตามจำนวนที่กำหนด
- Rate-limit/Circuit state ส่ง Schedule hint
- Hint แยก Source และ Baseline ลบงานเร่งด่วนไม่ได้
- Claim retry, Verification, Recovery, Stalled progress และ Deadline มี Candidate ของตัวเอง
- Bookkeeping/Hint error ไม่ทำ Caller promise ค้าง

## 10. Storage truth และ Backup

Storage mode ต้องรายงานตามจริง:

- `memory` — ไม่มี Durability และ Backup ปิด
- `local-development` — Local file สำหรับ Development
- `hosted-ephemeral` — Hosting ไม่มี Persistent mount และแสดง Warning
- `persistent-candidate` — `/var/data` เขียนได้แต่ยังต้อง Controlled restart

Fixed backup mappings:

- Database นอก `/var/data/` → `./data/backups`
- Database ใต้ `/var/data/` → `/var/data/backups`

ตรวจว่า:

1. Directory creation, Slot backup, Cleanup, Latest inspection และ Migration backup ใช้ Profile เดียวกัน
2. Retention ไม่เกิน 7 Slot
3. Backup สำเร็จ → `healthy`
4. Failure ครั้ง 1–2 → Log เท่านั้น
5. Failure ครั้ง 3 → เปิด `BACKUP_PROTECTION_LOST` หนึ่งรายการ
6. Backup เก่าเกิน 26 ชั่วโมงและความพยายามใหม่ล้ม → เปิด Incident
7. Incident เปิดอยู่แล้วไม่ Spam Webhook
8. Fast retry ทุก 15 นาทีสูงสุด 3 รอบ
9. สำเร็จอีกครั้งส่ง Recovery ด้วย Incident ID เดิม
10. Recovery delivery ล้มถูกเก็บ Pending และ Retry รอบถัดไป
11. `/api/status` ไม่แสดง Full database path หรือ Backup directory
12. Controlled restart แล้วยังพบ Database, Backup และ Scheduled rows

## 11. API status, Health และ Webhook security

ตรวจว่า:

- `/api-status` ใช้ได้เฉพาะ Owner/Admin/Manager
- HTTP `/api/status` ปิดเมื่อไม่มี `HEALTH_STATUS_TOKEN`
- เมื่อเปิดใช้ต้องตรวจ Exact Bearer token
- Public `/healthz` เปิดเผยเฉพาะ `{ ok }`
- Worker `/healthz` เป็น 503 ระหว่าง Bootstrap และ 200 หลัง Supervisor พร้อม
- Status แสดง Queue, 429, Scope, Circuit, Checkpoint errors, Workers และ Claims
- Status ไม่แสดง Token, Secret, Ciphertext, Full path หรือ Webhook URL
- Webhook ใช้ `allowed_mentions.parse: []`
- HTTP 400/401/403/404 ไม่ Retry
- HTTP 429/502/503/504 Retry สูงสุดหนึ่งครั้ง
- Network timeout หลังเริ่ม POST เป็น `delivery_unknown`
- Concurrent incident เดียวกันมี Network delivery หนึ่งรายการ
- Webhook failure ไม่ทำ Bot ดับ
- Recovery ใช้ Incident ID เดิม

## 12. Quality gates

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
```

GitHub Actions ต้องผ่านบน HEAD SHA ล่าสุด:

- Repository shape และ Runtime data safety
- Sanitized Quest fixture
- Fixed backup destinations
- Incident/Storage architecture boundaries
- Safe bootstrap และ Role-aware entrypoint
- Process topology/Worker ownership tests
- Durable state/Recovery/Stop tests
- Rate-limit/Circuit/Scheduler tests
- Fault injection tests
- Coverage gate 60%
- Critical mutation gate 6 ตัว
- `git diff --exit-code` หลัง Mutation gate
- JS/MJS/Bash syntax checks
- Production dependency audit ระดับ High

## 13. Controlled functional UAT

ใช้ Server และบัญชีทดสอบ ห้ามใช้บัญชีหลัก:

1. ผู้ใช้ทั่วไปเรียก `/api-status` แล้วถูกปฏิเสธ Ephemeral
2. Manager เห็น Topology/Storage/Backup/Durable state โดยไม่มี Secret
3. Start พร้อมกันหลายชุดไม่เกิน 10 Runner
4. Stop ระหว่างทำงานแล้วอยู่ `STOPPING` จน Terminal จริง
5. เปิด Auto Daily, Restart และตรวจ Restore
6. Enroll Quest และตรวจ `PREPARED → IN_FLIGHT → VERIFIED`
7. Video progress พร้อมจำลอง Response loss
8. Desktop heartbeat พร้อมจำลอง Worker claim loss
9. Claim reward พร้อม Verification absent และ Durable cooldown
10. Restart ที่ `PREPARED`, `IN_FLIGHT`, `UNCERTAIN`, `VERIFIED`
11. ยืนยันว่าไม่มี Blind duplicate mutation
12. สอง Worker แข่ง Scheduled row เดียวกันและมีผู้ชนะหนึ่งตัว
13. ปิด Worker เจ้าของงานและยืนยัน Takeover หลัง Lease expiry
14. Split mode: Stop จาก Control แล้ว Worker หยุดและ State เป็น `STOPPED`
15. Incident burst ส่ง Webhook หนึ่งข้อความ
16. Backup failure ไม่ Spam ทุก Fast retry
17. Restart/Redeploy แล้ว Database, Backup และ Scheduled Runner ยังอยู่
18. Panel ยังมีเพียง `START NOW / STOP ALL`

## 14. Quest API verification boundary

`npm run smoke:quest` เป็น Read-only ตรวจบัญชีและอ่านรายการ Quest ไม่ Enroll, Progress, Heartbeat หรือ Claim

CI/Smoke ไม่ใช่หลักฐานว่า Mutation จริงผ่านครบ การทดสอบ Mutation ต้องผ่านการอนุมัติความเสี่ยงและใช้บัญชีทดสอบ

## 15. Rollback

ก่อน Deploy:

- บันทึก Commit SHA
- ตรวจ Backup ล่าสุดเปิดอ่านได้
- เก็บ Environment เดิมอย่างปลอดภัย
- ยืนยัน Release branch ยังอยู่
- Split mode ต้องใช้ SHA เดียวกันทุก Process

เมื่อพบปัญหา:

1. หยุด Deployment ใหม่
2. Mark Workers not-ready และหยุด Control/Workers
3. Rollback ทุก Process ไป SHA เดียวกัน
4. Restore Database เฉพาะเมื่อยืนยันว่า Data/Schema เสีย
5. หมุน Secret/Webhook หากสงสัยว่ารั่ว
6. เพิ่ม Regression test ก่อน Deploy ใหม่

## 16. เกณฑ์อนุมัติ

อนุมัติ Production ได้เมื่อ:

- CI ของ HEAD ล่าสุดผ่านทั้งหมด
- Snyk, Codacy, SonarCloud และ CodeRabbit ผ่านหรือ Findings ถูกวิเคราะห์และอนุมัติอย่างมีหลักฐาน
- ไม่มี Review thread ที่ยังใช้ได้ค้าง
- Persistent storage ผ่าน Controlled restart
- Permission, Runner limit และ Stop lifecycle ผ่าน
- Discord Mutation UAT ผ่านด้วยบัญชีทดสอบ
- Multi-worker ใช้ Shared durable store จริงและ Failover UAT ผ่าน
- Backup/Incident/Recovery ผ่าน
- Rollback path ถูกยืนยัน
- ผู้ดูแลยอมรับความเสี่ยงด้านบัญชีและข้อกำหนดแพลตฟอร์ม

## 17. Repository data safety

- `git ls-files` ไม่พบ `.db`, `.sqlite`, WAL/SHM หรือ Runtime backups
- ตรวจ Git history และ Secret scanning ก่อน Merge
- หากพบ Credential จริงให้หมุนก่อน Deploy
- Control/Workers ต้องใช้ Shared `DATABASE_PATH`
- ห้ามถือ Local disk คนละตัวว่าเป็น Shared topology
- PR คง Draft จน Static analysis และ Controlled UAT พร้อมสำหรับ Review
