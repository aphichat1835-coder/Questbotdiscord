# Quest Engine Architecture

เอกสารนี้อธิบายโครงสร้าง Quest Engine หลังการ Hardening บนกิ่ง `aa.1` และใช้เป็นขอบเขตอ้างอิงสำหรับ Review, UAT, Deploy และ Incident response

## 1. ขอบเขตที่ล็อกไว้

- Discord HTTP API ใช้ `https://discord.com/api/v10` โดยตรง
- Discord panel เดิมคงไว้เฉพาะ `START NOW` และ `STOP ALL`
- One-shot token ไม่ถูก Persist เพิ่ม
- ไม่เพิ่ม Control Panel V2
- ไม่เพิ่ม Persistent analytics/history
- ไม่เพิ่ม Encryption key rotation
- ห้าม Retry Mutation แบบเดาสุ่มหรือส่งซ้ำก่อนตรวจ Server state
- PR ต้องคง Draft จน Controlled UAT และ External quality gates ผ่าน

## 2. Module boundaries

```text
src/quest/
├─ api/
│  ├─ discord-client.js
│  └─ quest-endpoints.js
├─ schema/
│  ├─ compatibility.js
│  └─ normalizer.js
├─ executors/
│  ├─ contract.js
│  ├─ registry.js
│  ├─ video-executor.js
│  ├─ desktop-executor.js
│  └─ unsupported-executor.js
├─ durable-mutation-verifier.js
├─ recovery-planner.js
├─ runner-execution-context.js
├─ runner-ownership-guard.js
├─ runner-state-store.js
├─ rate-limit-coordinator.js
├─ claim-retry-policy.js
├─ schedule-hint-bus.js
├─ smart-scheduler.js
├─ smart-wake-controller.js
├─ scheduled-worker-claims.js
├─ scheduled-worker-reconciler.js
└─ scheduled-worker-supervisor.js
```

`discord-runner.js` เป็น Orchestrator และ Presentation boundary สำหรับระบบเดิมเท่านั้น

Source of truth แยกดังนี้:

- API base, Headers, URL validation และ `DiscordApiError` → `quest/api/discord-client.js`
- Quest endpoint paths → `quest/api/quest-endpoints.js`
- Schema parsing และ Normalization → `quest/schema/*`
- Event support และ Progress loops → `quest/executors/*`
- Durable mutation checkpoint → `quest/runner-state-store.js`
- Fresh verification → `quest/durable-mutation-verifier.js`
- Retry classification ของ Claim → `quest/claim-retry-policy.js`
- Queue, Rate limit, Circuit และ Mutation barrier → `quest/rate-limit-coordinator.js`

Architecture tests ห้าม API/Header/Schema/Video/Desktop implementation กลับไปซ้ำใน `discord-runner.js`

## 3. Executor contract

Executor ทุกตัวต้องมี Method ครบ:

```js
{
  id,
  matches,
  validate,
  estimateDuration,
  execute,
  verify,
  describeUnsupportedReason,
}
```

Registry เป็นผู้เลือก Executor จาก Quest ที่ Normalize แล้ว:

- `video` — `WATCH_VIDEO*`
- `desktop` — `PLAY_ON_DESKTOP*`
- `unsupported` — Event ที่รู้จักแต่ระบบห้ามทำอัตโนมัติ
- `unknown` — Event ใหม่ที่ยังไม่มี Contract

Quest แบบ `join_operator=and` หลาย Task ไม่ถูกเลือกเป็น Automatic executor เพราะต้องยืนยันทุก Task ไม่ใช่เพียง Task เดียว

## 4. API และ Schema boundary

API client รับผิดชอบ:

- Header profile ที่สอดคล้องกันทั้ง Client/Chrome/Electron/Build
- API v10 โดยตรง
- URL boundary ที่ปฏิเสธ Authority, Query, Fragment, Backslash และ Traversal
- Quest-list fallback จาก `/quests/@me` ไป `/users/@me/quests`
- Enroll, Video progress, Heartbeat และ Claim request
- Fatal authentication classification
- Abort propagation โดยไม่เปลี่ยนเป็น Compatibility failure
- POST Mutation ไม่ใช้ Generic rate-limit retry
- Video jitter ใช้ `node:crypto.randomInt()` ไม่ใช้ `Math.random()`

Schema normalizer รับผิดชอบ:

- รองรับ `task_config_v2` และ Legacy `task_config`
- เลือก Progress key ให้ตรงกับ Task
- คำนวณ `progressSecs`, `progress`, `secondsNeeded`
- แยก `enrolled`, `completed`, `claimed`
- สร้าง Schema issue ที่เป็น Structured compatibility signal

`DiscordApiError` และ `QuestCompatibilityError` มี Class กลางอย่างละหนึ่งชุด และถูก Re-export ผ่าน Runner boundary เพื่อรักษา Compatibility ของผู้เรียกเดิม

## 5. Durable runner state

Scheduled runner เก็บ Checkpoint ใน SQLite โดยมีข้อมูลหลัก:

- Runner state
- Quest ID, Quest name และ Quest event
- Progress percent และ Server progress seconds
- Next action time
- Retry count
- Error category และ Last error
- Mutation kind/status/payload แบบ Sanitized
- Mutation attempted/verified timestamps
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

Payload ที่ Persist ต้องไม่มี Token, Cookie, CAPTCHA, Webhook URL หรือ Full response body

## 6. Mutation safety lifecycle

ลำดับที่บังคับใช้:

1. ตรวจ Worker ownership
2. Persist `PREPARED`
3. Persist `IN_FLIGHT`
4. ตรวจ Worker ownership ซ้ำก่อน Network execute
5. ส่ง Mutation
6. บันทึก `ACCEPTED`, `UNCERTAIN` หรือ `FAILED`
7. Block Mutation ถัดไปของ `jobKey` เดิม
8. Fetch Quest state ใหม่
9. Await Fresh verification และบันทึกผล Durable
10. ปลด Block เฉพาะเมื่อ `VERIFIED` หรือ Recovery ยืนยันว่า Retry ได้

Mutation barrier มีสองชั้น:

- In-memory barrier ใน Rate-limit coordinator ป้องกันคำขอชนกันใน Process เดียว
- Durable checkpoint barrier ป้องกันการเขียนทับ `PREPARED/IN_FLIGHT/ACCEPTED/UNCERTAIN` และทำงานต่อได้หลัง Restart

ถ้า Fresh state ยังไม่มีหลักฐาน, Verification ล้ม, Storage เขียนไม่ได้ หรือ Ownership หาย ระบบต้องคง Block และเข้าสู่ Recovery แทนการส่ง Mutation ใหม่

`executeVerifiedMutation()` อนุญาต Controlled retry เพียงเมื่อ Fresh verification พิสูจน์ว่า Mutation เดิมยังไม่ถูก Apply เท่านั้น

## 7. Recovery rules

หลัง Process restart:

| Durable evidence | Recovery action |
|---|---|
| Waiting state และ `next_action_at` ยังอยู่ในอนาคต | รอจนถึงเวลานั้น |
| Mutation เป็น `PREPARED/IN_FLIGHT/ACCEPTED/UNCERTAIN` | Fetch และ Verify ก่อนส่งซ้ำ |
| State เป็น `VERIFYING_*` | ทำ Verification ต่อ |
| State เป็น `VERIFYING_COMPLETION` | ตรวจ Completion ต่อ |
| Scheduled row ยัง Active แต่ Checkpoint เป็น Terminal | เริ่มจาก Fresh Server state |
| One-shot ถูกขัดจังหวะ | `FAILED` เพราะ Token ไม่ Durable |

กฎเพิ่มเติม:

- Crash หลัง Mutation แต่ก่อน State เปลี่ยนเป็น `VERIFYING_*` ยังต้องเข้าสู่ `VERIFY_MUTATION`
- Quest-list endpoint แรกที่คืนรายการว่างไม่ใช่หลักฐานว่า Quest หาย ต้องตรวจ Fallback endpoint ให้ครบ
- Missing, expired, incompatible, completed และ claimed Quest มี Recovery decision แยกกัน
- ห้าม Resend จาก `UNCERTAIN` checkpoint โดยไม่มี Fresh evidence

## 8. Claim retry durability

Claim cooldown ไม่พึ่ง In-memory `Map` เพียงอย่างเดียว แต่ Persist `next_action_at` และ Retry reason ลง Durable state

Retry classes:

- `CAPTCHA` — ใช้ Long cooldown เมื่อ Response มี CAPTCHA field จริง
- `PLATFORM_AMBIGUOUS` — ใช้ Long cooldown และไม่เดา Reward platform
- `REQUEST_REJECTED` — HTTP 400 ที่ไม่มี CAPTCHA ใช้ Standard cooldown และต้องตรวจ Fresh Quest state
- `RATE_LIMITED` — HTTP 429 ใช้ Rate-limit/Standard cooldown
- `VERIFICATION_ABSENT` — Claim request สำเร็จแต่ Discord ยังไม่ยืนยัน `claimed_at`
- `TEMPORARY_API_ERROR` — Network หรือ Server failure ชั่วคราว

HTTP 400 ทั่วไปห้ามถูกเหมารวมเป็น CAPTCHA และห้ามซ่อน API/Schema incompatibility ด้วย Cooldown 24 ชั่วโมง

เมื่อ Restart Scheduler จะอ่าน Cooldown จาก Durable state และไม่ Claim ซ้ำก่อนเวลา

## 9. Rate-limit coordinator

Coordinator รองรับ:

- Serialization ต่อบัญชี
- Route-to-bucket mapping
- `X-RateLimit-Scope`: `user`, `shared`, `global`
- `Retry-After` และ JSON body `retry_after`
- Global pause
- Request priority
- Circuit breaker: `CLOSED`, `OPEN`, `HALF_OPEN`
- Source-aware Schedule hints
- Mutation barrier ต่อ `jobKey`
- Fresh Quest verification ที่ Await ก่อน Resolve Quest-list response

Authorization ใน Queue เก็บเป็น SHA-256 fingerprint ไม่เก็บ Raw token

Mutation ตรวจ Ownership ทั้งก่อนเข้า Queue และก่อน Network execute เพื่อป้องกัน Lease หมดระหว่างรอ Bucket/Circuit

## 10. Smart scheduling และ Smart wake

Hint bus เก็บ Hint แยกตาม Source เพื่อไม่ให้ Baseline ลบงานเร่งด่วน:

- Quest list
- Claim retry
- Verification
- Runner retry
- Rate limit
- Circuit breaker
- Recovery
- Baseline schedule

Priority หลัก:

1. Claim ที่พร้อมรับรางวัล
2. Deadline ใกล้หมด
3. Rate-limit/Circuit recovery
4. Verification และ Stalled progress
5. Retry
6. Enrollment/Start time
7. Baseline schedule

Smart wake:

- ใช้กับ Scheduled runner เท่านั้น
- ไม่ปลุกซ้ำเมื่อ Fixed schedule เดิมมาก่อน Hint
- รอ `job.done` ก่อน Restart
- ไม่ลบ Scheduled row ระหว่าง Restart
- ยกเลิกเมื่อ Scheduled row ถูกลบ
- Restart failure ต้องถูก Persist เป็น Durable `FAILED`
- Timer ระยะไกลถูกแบ่งเป็นช่วงไม่เกิน 24 ชั่วโมงเพื่อเลี่ยง `setTimeout` overflow

## 11. Multi-worker ownership

Worker process แต่ละตัวสร้าง Holder จาก `process.pid` และ `randomUUID()`

Topology rules:

- `all` ห้ามทำงานพร้อม `control` หรือ Worker ใด ๆ
- `control` อนุญาตเพียง Holder เดียว
- Worker หลาย Holder ทำงานพร้อมกันได้
- Scheduled row หนึ่งแถวมี Active claim ได้เพียง Holder เดียว
- Worker ต้อง Renew runtime lease และ Job claim
- Worker ที่เสีย Claim ต้อง Abort local runner ก่อน Mutation ถัดไป
- Worker อื่นรับช่วงได้เมื่อ Claim หมดอายุ

Shutdown order:

1. Mark worker not-ready
2. หยุด Supervisor ไม่ให้รับงานใหม่
3. Abort local runners
4. รอ `job.done` settle
5. ปล่อย Scheduled claims
6. ปล่อย Runtime lease
7. ปิด Database

Control และ Workers ทุกตัวต้องใช้ Durable SQLite เดียวกันจริง การแยก Local disk ต่อ Service ไม่ใช่ Split topology ที่รองรับ

## 12. State authority

Business state ที่มาจาก `quest-orchestrator`, Mutation coordinator หรือ Recovery planner เป็น Source of truth

Status-text observer ใช้สำหรับ:

- Sync diagnostics
- Legacy rows ที่ยังไม่มี Direct state source
- Presentation metadata

ข้อความ UI ห้ามย้อนเปลี่ยน Direct business state

## 13. Quality gates

CI บังคับ:

- Repository shape และ Runtime data safety
- Sanitized Quest fixture
- Storage/Incident boundaries
- Full tests แบบ SQLite-isolated file order
- Coverage line gate รวม
- Lifecycle coverage สำหรับ Runner, Runner service, Supervisor และ Smart wake
- Architecture boundary ป้องกัน API/Header/Schema/Executor duplication
- Critical mutation gate 6 ตัว
- ยืนยัน Mutation gate คืน Source เดิมด้วย `git diff --exit-code`
- Syntax check สำหรับ JS/MJS และ Bash
- Production dependency audit ระดับ High

Mutation gate ครอบคลุม:

1. Skip verification หลัง Uncertain mutation
2. Deadline comparison กลับด้าน
3. Ignore uncertain Recovery checkpoint
4. ยอมรับ Multi-task AND อัตโนมัติ
5. Ignore explicit Durable checkpoint update
6. Bypass user-scoped rate-limit bucket

## 14. Controlled UAT ที่ยังต้องทำ

CI ไม่ใช่หลักฐานว่า Discord Mutation จริงผ่าน Production API ครบ ต้องใช้บัญชีและ Server ทดสอบเท่านั้น

UAT ขั้นต่ำ:

1. Enroll Quest ทดสอบและตรวจ Durable lifecycle
2. Video progress พร้อม Restart หลัง Response loss
3. Desktop heartbeat พร้อม Worker claim loss
4. Claim reward พร้อม Verification absent/cooldown
5. HTTP 400 แบบ CAPTCHA และ Non-CAPTCHA ต้องเข้าคนละ Retry class
6. สอง Worker แข่ง Claim row เดียวกัน
7. ปิด Worker เจ้าของงานและยืนยัน Takeover หลัง Lease expiry
8. Stop จาก Control ระหว่าง Mutation และยืนยัน `STOPPING → STOPPED`
9. Restart ระหว่าง `PREPARED`, `IN_FLIGHT`, `UNCERTAIN`, `VERIFIED`
10. ตรวจว่าไม่มี Blind duplicate mutation
11. Persistent storage restart/redeploy แล้วยังพบ Database, Backup และ Scheduled rows
12. ตรวจ Panel ว่ายังคงมีเพียง `START NOW / STOP ALL`

## 15. Deployment limitations

- SQLite ต้องอยู่บน Storage ที่ทุก Process เข้าถึงไฟล์เดียวกันอย่างเชื่อถือได้
- ไม่รองรับ Workers ที่มี Database คนละไฟล์
- ไม่รับประกัน Production readiness จน Controlled UAT และ Persistent restart ผ่าน
- PR ต้องคง Draft และห้าม Merge จน External analysis, Review และ UAT ครบ
