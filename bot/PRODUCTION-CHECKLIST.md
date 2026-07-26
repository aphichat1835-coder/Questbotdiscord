# Production Readiness Checklist

เอกสารนี้ใช้ตรวจรับ Pull Request หรือกิ่ง Release ก่อน Merge หรือ Deploy ระบบ NeverDie Quest Bot

## 1. ขอบเขตที่ต้องยืนยัน

- Repository เป็น Bot-only และไม่มี Desktop/Tauri/CDP/Game Simulator กลับเข้ามา
- Panel เดิมยังเป็น `START NOW` / `STOP ALL`
- Runner สูงสุด 10 บัญชีต่อ Owner และคำสั่งพร้อมกันไม่ทำให้เกินจำนวน
- One-shot หยุดเองเมื่อไม่มี Quest ที่รองรับ
- Auto Daily ตรวจทันทีและตามเวลา 00:00 / 08:00 / 16:00 ใน Timezone ที่กำหนด
- Smart wake ไม่ตัด Progress mutation กลางทาง
- Stop รอ Cleanup และไม่ประกาศสำเร็จก่อน Durable terminal confirmation
- `/api-status` ใช้ได้เฉพาะ Owner/Admin/Manager
- HTTP `/api/status` ปิดเมื่อไม่มี `HEALTH_STATUS_TOKEN` และใช้ Exact Bearer token เมื่อเปิด
- Public `/healthz` เปิดเผยเฉพาะ `{ ok }`
- Render/Console logs เก็บ Error ทุกระดับ
- Discord Webhook ส่งเฉพาะ Structured Incident ตาม Policy และ Threshold
- Fatal shutdown และ Resource cleanup ไม่ทำงานซ้อนจาก Error burst เดียวกัน

## 2. Environment

ค่าหลักที่ต้องตั้งครบทุก Process:

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
DATABASE_PATH=
DATABASE_BACKUP_ENABLED=
DATABASE_BACKUP_RETENTION=7
HEALTH_STATUS_TOKEN=
PORT=
QUEST_PROCESS_ROLE=all
QUEST_WORKER_POLL_MS=5000
```

ข้อกำหนด:

- `RUNNER_TOKEN_SECRET` ยาวอย่างน้อย 16 ตัวอักษร เป็น Secret แบบสุ่ม และห้าม Commit
- `LOG_WEBHOOK_URL` เป็น Discord HTTPS Incoming Webhook ส่วนตัวและถือเป็น Credential
- `HEALTH_STATUS_TOKEN` เมื่อเปิดใช้ต้องเป็น Secret คนละค่ากับ Token อื่น
- `QUEST_PROCESS_ROLE` รับเฉพาะ `all`, `control`, `worker`
- `QUEST_WORKER_POLL_MS` อยู่ระหว่าง 1000–60000 ms
- ค่า Discord client profile ต้องอัปเดตพร้อมกันทั้งชุดและ Restart
- ห้ามใช้ `DATABASE_BACKUP_DIR`
- Runtime ห้ามเขียนค่าอัตโนมัติกลับเข้า `process.env.DATABASE_PATH`

## 3. Process topology

### All-in-one

- ใช้ `QUEST_PROCESS_ROLE=all`
- เปิด Gateway, Commands, One-shot และ Auto Daily ใน Process เดียว
- เป็นค่าเริ่มต้นและรูปแบบแนะนำสำหรับ Single-service deployment

### Split Control + Worker

Control:

```env
QUEST_PROCESS_ROLE=control
PORT=3000
```

Worker:

```env
QUEST_PROCESS_ROLE=worker
PORT=3001
```

ต้องยืนยัน:

1. Control และ Worker ใช้ `DATABASE_PATH` เดียวกันจริง
2. ใช้ `RUNNER_TOKEN_SECRET` เดียวกัน
3. ใช้ Port คนละค่า
4. Filesystem/Database รองรับการเข้าถึงจากทั้งสอง Process อย่างน่าเชื่อถือ
5. One-shot อยู่ Control และไม่ Persist Token เพิ่ม
6. Scheduled row จาก Control ถูก Worker รับภายใน Poll interval
7. Worker ใช้ Discord REST v10 และไม่เปิด Gateway
8. Worker `/healthz` เป็น 503 ระหว่าง Bootstrap และ 200 หลัง Restore/Supervisor พร้อม
9. `all` ชนกับ `control`/`worker`
10. Control ซ้ำหรือ Worker ซ้ำด้วย Holder คนละตัวถูกปฏิเสธ
11. Lease หมดอายุหลัง Process ไม่ Renew
12. Deployment ที่แต่ละ Service มี Local disk แยกกันไม่ใช้ Split mode

## 4. Safe bootstrap และ Shutdown

1. Bootstrap handlers ติดตั้งก่อน Dynamic import ของ Config/Runtime
2. Config/Module import failure ถูกบันทึกโดยไม่พึ่ง SQLite หรือ Discord Client
3. Entrypoint เลือก `app.js` หรือ `worker-app.js` ตาม Role
4. Database open failure ใช้ `DATABASE_OPEN_FAILED`
5. Schema/migration failure ใช้ `DATABASE_MIGRATION_FAILED`
6. Topology lease conflict/lost ทำให้ Process ปิดอย่างปลอดภัย
7. Health server bind failure Reject Startup
8. Control/All login failure ส่ง Incident แล้ว Shutdown
9. Worker ไม่ Login Gateway
10. Fatal report ใช้ Budget จำกัด 3.5 วินาที
11. Runtime ใช้ Fatal promise และ Shutdown promise อย่างละชุดเดียว
12. Signal ปกติชน Fatal errorต้องรักษา Exit code ที่รุนแรงที่สุด
13. Worker Mark not-ready ก่อน Shutdown
14. Dashboard ที่กำลัง Bind ถูกปิด ไม่ทิ้ง Server ไม่มีเจ้าของ

## 5. Storage truth

ระบบต้องรายงาน Storage modeตามจริง:

- `memory` — ไม่มี Durability และ Backup ปิด
- `local-development` — Local file สำหรับ Development
- `hosted-ephemeral` — Hosting ไม่มี Persistent mount และแสดง Warning
- `persistent-candidate` — `/var/data` เขียนได้แต่ยังต้อง Controlled restart

Fixed backup mappings:

- Database นอก `/var/data/` → `./data/backups`
- Database ใต้ `/var/data/` → `/var/data/backups`

ตรวจว่า Directory creation, Slot backup, Cleanup, Latest inspection และ Migration backup ใช้ Backup profile เดียวกัน เก็บไม่เกิน 7 Slot และ Restart แล้วยังอยู่

## 6. Backup protection

1. Backup สำเร็จ → `healthy`
2. Failure ครั้ง 1–2 → Log เท่านั้น
3. Failure ครั้ง 3 → เปิด `BACKUP_PROTECTION_LOST` หนึ่งรายการ
4. Backup เก่าเกิน 26 ชั่วโมงและความพยายามใหม่ล้ม → เปิด Incident
5. Incident เปิดอยู่แล้วห้ามยิง Webhook ซ้ำทุกครั้ง
6. Fast retry ทุก 15 นาทีสูงสุด 3 รอบ
7. สำเร็จอีกครั้งส่ง Recovery ด้วย Incident ID เดิม
8. Recovery delivery ล้มถูกเก็บ Pending และ Retry รอบถัดไป
9. `/api/status` แสดง Last success, age, failure, retry และ recovery state
10. Status ไม่แสดง Full database path หรือ Backup directory

## 7. Discord API และ Rate limit

- Outbound Discord API ถูกส่งจริงเป็น v10
- `Request` object รักษา Method/Headers/Body
- URL ภายนอกและ Webhook ไม่ถูก Rewrite
- บัญชีเดียวไม่ยิงพร้อมกันเกินหนึ่ง Request
- Global 429 หยุด Queue ทั้งหมด
- Bucket timer ตื่นตามเวลาที่เร็วที่สุด
- Claim/Verification Priority สูงกว่า Background
- Authorization ใน Queue เป็น Fingerprint ไม่ใช่ Raw token
- Bookkeeping/Hint error ไม่ทำ Caller promise ค้าง
- Worker REST clientเลือก Runtime fetch ตอน Request จริง

## 8. Durable state, Restore และ Stop

- Partial transition รักษา Checkpoint ที่ไม่ได้ส่งค่าใหม่
- Explicit `null` เคลียร์ Optional field ได้
- Scheduled interruption → `RECOVERING`
- One-shot interruption → `FAILED`
- Orphaned recovering state → `FAILED`
- Restore ไม่ถือ `account_id=null` หลายแถวเป็นบัญชีเดียว
- Restore จำกัด 10 Runner ต่อ Owner
- Failed worker rowมี Retry cooldown 5 นาที
- Control stop ตั้ง `STOPPING` เมื่อ Worker อาจยังทำงาน
- Worker Abort job เมื่อ Scheduled row หาย
- Worker เปลี่ยน Detached `STOPPING` เป็น `STOPPED` เมื่อทั้ง row/job หาย
- `/stop` รายงาน Pending เมื่อ Terminal confirmation ยังไม่มาถึง
- Stop ไม่ลบ Scheduled row ระหว่าง Smart wake restart

## 9. Emergency Webhook validation

ใช้ Webhook ทดสอบแยกจาก Production:

1. Incident จำลองส่ง Rich Embed สำเร็จ
2. Embed มี Code, Incident ID, Impact, Action, Runtime และ Deployment
3. `allowed_mentions.parse` เป็น Array ว่าง
4. Token, Secret, Cookie, CAPTCHA, Email, Ciphertext, Password และ Webhook URL ไม่ปรากฏ
5. Context ใช้ Deep-frozen allowlist
6. `constructor`, `toString`, `__proto__` ถูกปฏิเสธ
7. HTTP 400/401/403/404 ไม่ Retry
8. HTTP 429/502/503/504 Retry สูงสุดหนึ่งครั้ง
9. Network timeout หลังเริ่ม POST เป็น `delivery_unknown`
10. Concurrent incident เดียวกันมี Network delivery หนึ่งรายการ
11. Webhook ล้มไม่ทำ Bot ดับ
12. Recovery ใช้ Incident ID เดิม

## 10. Quality gates

รันจากโฟลเดอร์ `bot`:

```bash
npm ci --ignore-scripts --no-fund --no-audit
npm rebuild better-sqlite3 --foreground-scripts
npm run validate:quest-fixture
npm test
npm run check
npm audit --omit=dev --audit-level=high
```

GitHub Actions ต้องผ่าน:

- Repository shape และ Runtime data safety
- Sanitized Quest fixture
- Fixed backup destinations
- Incident/Storage architecture boundaries
- Environment contract และ no-mutation tests
- Safe bootstrap และ Role-aware entrypoint
- Process topology leases
- Worker REST/readiness/Supervisor tests
- Durable state/Restore/Stop tests
- Smart scheduler/wake tests
- Fault injection และ Mutation verification tests
- Coverage gate
- Syntax check
- Production dependency audit

CI, Snyk, Codacy, SonarCloud และ CodeRabbit ต้องเป็นผลของ HEAD SHA ล่าสุด

## 11. Controlled functional validation

ทดสอบใน Server และบัญชีทดสอบ:

1. ผู้ใช้ทั่วไปเรียก `/api-status` แล้วถูกปฏิเสธ Ephemeral
2. Manager เห็น Process topology, Storage, Backup และ Durable state โดยไม่มี Secret
3. Modal พร้อมกันหลายชุดไม่เกิน 10 Runner
4. Stop ระหว่างทำงานแล้วบัญชีอยู่ Cleanup จน Terminal จริง
5. เปิด Auto Daily, Restart และตรวจ Restore
6. ข้อความ Runner ไม่เกิน Discord message limit
7. Backup Slot และ Retention ถูกต้อง
8. `/healthz` ไม่เปิดเผยรายละเอียด
9. Protected `/api/status` ปฏิเสธ Bearer token ผิด
10. Incident burst ส่ง Webhook เพียงหนึ่งข้อความ
11. Backup failure ไม่ Spam ทุก Fast retry
12. Restart/Redeploy แล้ว Database, Backup และ Scheduled Runner ยังอยู่
13. Split mode: Start Control ก่อน Worker แล้ว Scheduled row ถูก Worker รับ
14. Split mode: Stop จาก Control แล้ว Workerหยุดและ Durable state เป็น `STOPPED`
15. Split mode: ปิด Workerแล้ว Control `/healthz` ยังสะท้อนเฉพาะ Control readiness
16. All-in-one และ Split topology ไม่สามารถทำงานพร้อมกัน

## 12. Quest API verification boundary

`npm run smoke:quest` เป็น Read-only ตรวจบัญชีและอ่านรายการ Quest ไม่ Enroll, Progress, Heartbeat หรือ Claim

CI/Smoke ไม่ใช่หลักฐานว่า Mutation จริงผ่านครบ การทดสอบ Mutation ต้องใช้บัญชีทดสอบและผ่านการอนุมัติความเสี่ยง ห้ามใช้บัญชีหลัก

## 13. Rollback

ก่อน Deploy:

- บันทึก Commit SHA
- ตรวจ Backup ล่าสุดเปิดอ่านได้
- เก็บ Environment เดิมอย่างปลอดภัย
- ยืนยัน Release branch ยังอยู่
- สำหรับ Split mode บันทึก SHA ของ Control และ Workerให้ตรงกัน

เมื่อพบปัญหา:

1. หยุด Deployment ใหม่
2. หยุดทั้ง Control และ Workerก่อนเปลี่ยน Version
3. Rollback ทุก Process ไป SHA เดียวกัน
4. Restore Database เฉพาะเมื่อยืนยันว่า Data/Schema เสีย
5. หมุน Secret/Webhook หากสงสัยว่ารั่ว
6. เพิ่ม Regression test ก่อน Deploy ใหม่

## 14. เกณฑ์อนุมัติ

อนุมัติ Production ได้เมื่อ:

- CI ของ HEAD ล่าสุดผ่านทั้งหมด
- Snyk, Codacy, SonarCloud และ CodeRabbit ผ่านหรือ Warning ถูกวิเคราะห์
- ไม่มี Review thread ที่ยังใช้ได้ค้าง
- Persistent storage ผ่าน Controlled restart
- Permission, Runner limit และ Stop lifecycle ผ่าน
- Split mode ผ่านเฉพาะเมื่อมี Shared durable store จริง
- Backup/Incident/Recovery ผ่าน
- Rollback path ถูกยืนยัน
- ผู้ดูแลยอมรับความเสี่ยงด้านบัญชีและข้อกำหนดแพลตฟอร์ม

## 15. Repository data safety

- `git ls-files` ไม่พบ `.db`, `.sqlite`, WAL/SHM หรือ Runtime backups
- ตรวจ Git history และ Secret scanning ก่อน Merge
- หากพบ Credential จริงให้หมุนก่อน Deploy
- Production Replica เป็น 1 ต่อ Role
- Control/Worker ต้องใช้ Shared `DATABASE_PATH`; ห้ามใช้ Database คนละไฟล์แล้วถือว่าเป็น Split topology
