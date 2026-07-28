# Quest Engine Architecture

เอกสารนี้อธิบาย Quest Engine หลังการตรวจโค้ดและแก้ Correctness findings บนกิ่ง `aa.1` ใช้เป็นขอบเขตอ้างอิงสำหรับ Review, UAT, Deploy และ Incident response

## 1. ขอบเขตที่ล็อกไว้

- Discord HTTP API ใช้ `https://discord.com/api/v10` โดยตรง
- Discord panel คงไว้เฉพาะ `START NOW` และ `STOP ALL`
- One-shot token ไม่ถูก Persist เพิ่ม
- ไม่เพิ่ม Control Panel V2
- ไม่เพิ่ม Persistent analytics/history
- ไม่เพิ่ม Encryption key rotation
- ห้าม Retry Mutation แบบเดาสุ่มหรือส่งซ้ำก่อนตรวจ Fresh server state
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
├─ all-mode-recovery.js
├─ runner-completion-release.js
├─ durable-mutation-verifier.js
├─ recovery-planner.js
├─ runner-execution-context.js
├─ runner-ownership-guard.js
├─ runner-state-store.js
├─ runner-state-observer.js
├─ rate-limit-coordinator.js
├─ claim-retry-policy.js
├─ schedule-hint-bus.js
├─ smart-scheduler.js
├─ smart-wake-controller.js
├─ scheduled-worker-claims.js
├─ scheduled-worker-reconciler.js
└─ scheduled-worker-supervisor.js
```

`discord-runner.js` เป็น Orchestrator และ Presentation boundary ของระบบเดิม ส่วน Lifecycle สำหรับ Production ต้องผ่าน `quest/runner-service.js`

Source of truth:

- API base, Headers, URL validation และ `DiscordApiError` → `quest/api/discord-client.js`
- Quest endpoint paths → `quest/api/quest-endpoints.js`
- Schema parsing และ Numeric validation → `quest/schema/*`
- Event support และ Progress loops → `quest/executors/*`
- Durable mutation checkpoint → `quest/runner-state-store.js`
- Fresh verification → `quest/durable-mutation-verifier.js`
- Retry classification ของ Claim → `quest/claim-retry-policy.js`
- Queue, Rate limit, Circuit และ Mutation barrier → `quest/rate-limit-coordinator.js`
- All-in-one delayed recovery → `quest/all-mode-recovery.js`
- Safe execution-context release → `quest/runner-completion-release.js`

Architecture tests ห้าม API/Header/Schema/Video/Desktop implementation กลับไปซ้ำใน Runner และห้าม Production entrypoint เรียก Legacy restore โดยตรง

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

Registry เป็นผู้เลือก Executor:

- `video` — `WATCH_VIDEO*`
- `desktop` — `PLAY_ON_DESKTOP*`
- `unsupported` — Event หรือ Schema ที่ระบบห้ามทำอัตโนมัติ
- `unknown` — Event ใหม่ที่ยังไม่มี Contract

Quest แบบ `join_operator=and` หลาย Task ไม่ถูกทำอัตโนมัติ เพราะต้องยืนยันทุก Task ไม่ใช่เพียง Task เดียว

## 4. API และ Schema boundary

API client รับผิดชอบ:

- Header profile ที่สอดคล้องกันทั้ง Client/Chrome/Electron/Build
- API v10 โดยตรง
- URL boundary ที่ปฏิเสธ Authority, Query, Fragment, Backslash และ Traversal
- Quest-list fallback จาก `/quests/@me` ไป `/users/@me/quests`
- Enroll, Video progress, Heartbeat และ Claim request
- Fatal authentication classification
- Abort propagation โดยไม่เปลี่ยนเป็น Compatibility failure
- POST Mutation ไม่ใช้ Generic blind retry
- Video progress timestamp ต้องเป็นจำนวนเต็มไม่ติดลบ และส่งค่าที่ตรวจแล้วตรง ๆ

ไม่มี Video timestamp jitter ปลอมใน Request path อีกต่อไป Schedule jitter สำหรับกระจายเวลาตรวจรอบยังคงเป็นระบบคนละส่วน

Schema normalizer รับผิดชอบ:

- รองรับ `task_config_v2` และ Legacy `task_config`
- เลือก Progress key ให้ตรงกับ Task
- คำนวณ `progressSecs`, `progress`, `secondsNeeded`
- แยก `enrolled`, `completed`, `claimed`
- Numeric string ที่เป็นค่าถูกต้องรับได้
- Target ต้องเป็น Finite number มากกว่า 0
- Progress ต้องเป็น Finite number และไม่ติดลบ
- ห้าม `NaN`, `Infinity` หรือค่าติดลบไหลเข้า Executor, State หรือ Status
- Progress มากกว่า Target ถูก Clamp เฉพาะเปอร์เซ็นต์ที่ 100
- `TASK_TARGET_INVALID`, `TASK_PROGRESS_INVALID`, `TASK_DEFINITIONS_MISSING` และ `MULTI_TASK_AND` เป็น Blocking compatibility issues

Quest ที่มี Blocking issue:

- ยังนับในจำนวน Quest ทั้งหมดเพื่อการวินิจฉัย
- ไม่ถูกนับใน `supportedCount`
- ไม่เข้าสู่ One-shot session
- ไม่ถูกส่ง Enrollment, Progress, Heartbeat หรือ Claim

## 5. Durable runner state

Scheduled runner เก็บใน SQLite:

- Runner state
- Quest ID/name/event
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

ลำดับบังคับ:

1. ตรวจ Worker ownership
2. Persist `PREPARED`
3. Persist `IN_FLIGHT`
4. ตรวจ Ownership ซ้ำก่อน Network execute
5. ส่ง Mutation
6. บันทึก `ACCEPTED`, `UNCERTAIN` หรือ `FAILED`
7. Block Mutation ถัดไปของ `jobKey` เดิม
8. Fetch Quest state ใหม่
9. Await Fresh verification และบันทึกผล Durable
10. ปลด Block เฉพาะเมื่อ `VERIFIED` หรือ Recovery ยืนยันว่า Retry ได้

Mutation barrier มีสองชั้น:

- In-memory barrier ป้องกันคำขอชนกันใน Process เดียว
- Durable checkpoint barrier ป้องกันการเขียนทับ `PREPARED/IN_FLIGHT/ACCEPTED/UNCERTAIN` และทำงานต่อหลัง Restart

ถ้า Fresh state ไม่มีหลักฐาน, Verification ล้ม, Storage เขียนไม่ได้ หรือ Ownership หาย ระบบต้องคง Block และเข้าสู่ Recovery แทนการส่ง Mutation ใหม่

## 7. Recovery rules

หลัง Process restart:

| Durable evidence | Recovery action |
|---|---|
| Waiting state และ `next_action_at` อยู่อนาคต | รอจนถึงเวลานั้น |
| Mutation เป็น `PREPARED/IN_FLIGHT/ACCEPTED/UNCERTAIN` | Fetch และ Verify ก่อนส่งซ้ำ |
| State เป็น `VERIFYING_*` | ทำ Verification ต่อ |
| Scheduled row Active แต่ Checkpoint Terminal | เริ่มจาก Fresh server state |
| One-shot ถูกขัดจังหวะ | `FAILED` เพราะ Token ไม่ Durable |

กฎเพิ่มเติม:

- Crash หลัง Mutation แต่ก่อน State เปลี่ยนยังต้องเข้า `VERIFY_MUTATION`
- Endpoint แรกที่คืนรายการว่างไม่ใช่หลักฐานว่า Quest หาย ต้องตรวจ Fallback ให้ครบ
- Missing, expired, incompatible, completed และ claimed Quest มี Decision แยกกัน
- ห้าม Resend จาก `UNCERTAIN` โดยไม่มี Fresh evidence

### All-in-one recovery

ค่าเริ่มต้น `QUEST_PROCESS_ROLE=all` ไม่มี Worker supervisor จึงใช้ `all-mode-recovery.js` รับผิดชอบ Runner ที่ Completion observer เปลี่ยนเป็น `WAITING_RETRY`

ก่อนตั้ง Timer และก่อน Restore ต้องตรวจซ้ำว่า:

- Mode ยังเป็น Scheduled
- Process role เป็น `all`
- Durable state ยังเป็น `WAITING_RETRY`
- `schedule_id` ตรงกับ Context
- Scheduled row ยังอยู่
- ไม่มี Replacement job ทำงานอยู่
- ถึง `next_action_at` แล้วจริง

Recovery timer ไม่เก็บ User token ตัว Token ถูก Decrypt จาก Scheduled row ผ่าน Restore path มาตรฐานเมื่อถึงเวลาจริง Stop และ Shutdown ต้องยกเลิก Timer ทั้งหมด

## 8. Completion and cleanup safety

Execution context ต้องถูก Release ทั้งกรณี `job.done` Resolve และ Reject

`runner-completion-release.js` ต้อง:

- Consume Rejection ของ Derived promise
- Release เพียงครั้งเดียว
- จับ Error จาก Release callback
- ไม่สร้าง `unhandledRejection`
- ไม่ทำให้ Runner หนึ่งบัญชีล้มแล้วพา Process ปิดทั้งตัว

Completion observer ยังคงเป็นผู้บันทึก Business failure ลง Durable state

## 9. Claim retry durability

Retry classes:

- `CAPTCHA` — Long cooldown เมื่อมี CAPTCHA evidence จริง
- `PLATFORM_AMBIGUOUS` — Long cooldown และไม่เดา Platform
- `REQUEST_REJECTED` — HTTP 400 ไม่มี CAPTCHA ใช้ Standard cooldown
- `RATE_LIMITED` — HTTP 429
- `VERIFICATION_ABSENT` — Discord ยังไม่ยืนยัน `claimed_at`
- `TEMPORARY_API_ERROR` — Network หรือ Server failure ชั่วคราว

HTTP 400 ทั่วไปห้ามถูกเหมารวมเป็น CAPTCHA และ Cooldown ต้อง Persist ผ่าน Restart

## 10. Rate-limit coordinator

Coordinator รองรับ:

- Serialization ต่อบัญชี
- Route-to-bucket mapping
- Scope `user`, `shared`, `global`
- `Retry-After` และ JSON `retry_after`
- Global pause และ Request priority
- Circuit breaker `CLOSED`, `OPEN`, `HALF_OPEN`
- Source-aware schedule hints
- Mutation barrier ต่อ `jobKey`
- Fresh Quest verification ที่ Await ก่อน Resolve Quest-list response

Authorization ใน Queue เก็บเป็น SHA-256 fingerprint ไม่เก็บ Raw token

## 11. Smart scheduling และ Smart wake

Hint bus เก็บ Hint แยกตาม Source เพื่อไม่ให้ Baseline ลบงานเร่งด่วน

Smart wake:

- ใช้กับ Scheduled runner เท่านั้น
- ไม่ปลุกซ้ำเมื่อ Fixed schedule เดิมมาก่อน Hint
- รอ `job.done` ก่อน Restart
- ไม่ลบ Scheduled row ระหว่าง Restart
- ยกเลิกเมื่อ Scheduled row ถูกลบ
- ยกเลิก Timer เก่าเมื่อ Effective hint กลับเป็น `baseline` หรือ `null`
- ยกเลิก Timer เก่าเมื่อ Hint timestamp ไม่ถูกต้อง
- ไม่ Restart ทับ Replacement job
- Restart failure ถูก Persist เป็น Durable `FAILED`
- Timer ระยะไกลแบ่งช่วงไม่เกิน 24 ชั่วโมง

## 12. Multi-worker ownership

Topology rules:

- `all` ห้ามทำงานพร้อม `control` หรือ Worker
- `control` อนุญาต Holder เดียว
- Worker หลาย Holder ทำงานพร้อมกันได้
- Scheduled row หนึ่งแถวมี Active claim ได้เพียง Holder เดียว
- Worker ต้อง Renew runtime lease และ Job claim
- Worker ที่เสีย Claim ต้อง Abort local runner ก่อน Mutation ถัดไป
- Worker อื่นรับช่วงได้เมื่อ Claim หมดอายุ

Shutdown order:

1. Mark worker not-ready
2. หยุด Supervisor
3. Abort local runners
4. รอ `job.done` settle
5. ปล่อย Scheduled claims
6. ปล่อย Runtime lease
7. ปิด Database

Control และ Workers ต้องใช้ SQLite ไฟล์เดียวกันจริง

## 13. State authority

Direct Business state เป็น Source of truth แต่ Status observer อนุญาตให้ข้อความ Runtime ที่ยืนยันการ Sleep อัปเดต State ที่ค้างเป็น:

- `NETWORK RETRY` → `WAITING_RETRY`
- `NEXT CHECK` หรือ `AUTO DAILY ACTIVE` → `WAITING_SCHEDULE`

Observer ห้ามเขียนทับ:

- Active mutation checkpoint
- `WAITING_ENROLLMENT`
- `WAITING_RATE_LIMIT`
- State จาก `schedule-hint:*`
- `STOPPING`, `STOPPED`, `COMPLETED`, `FAILED`

## 14. Legacy compatibility boundary

`discord-runner.js` ยังมี Compatibility exports สำหรับ Test/ผู้เรียกเดิม แต่ Production entrypoint, Commands และ Lifecycle ต้องผ่าน `quest/runner-service.js`

- ห้าม Production import Legacy restore โดยตรง
- `speedMultiplier` ไม่มี Production caller และห้ามเพิ่ม Caller ใหม่
- การทำความสะอาด Compatibility code ภายในไฟล์ใหญ่ต้องแยกเป็น Refactor PR ไม่ปนกับ Correctness patch

## 15. Quality gates

CI บังคับ:

- Repository shape และ Runtime data safety
- Sanitized Quest fixture
- Storage/Incident boundaries
- Full tests แบบ SQLite-isolated order
- Coverage gate
- Lifecycle coverage
- Architecture boundaries
- Critical mutation gate 13 ตัว
- Mutation gate คืน Source ด้วย `git diff --exit-code`
- Syntax check JS/MJS/Bash
- Production dependency audit ระดับ High

Mutation gate ครอบคลุม:

1. Skip fresh verification หลัง Uncertain mutation
2. Deadline comparison กลับด้าน
3. Ignore uncertain Recovery checkpoint
4. ยอมรับ Incompatible Quest โดย Automatic executor
5. Ignore explicit Durable checkpoint update
6. Bypass user-scoped bucket
7. ยอมรับ Invalid target
8. ยอมรับ Invalid progress
9. Baseline ไม่ล้าง Smart Wake timer
10. Rejected completion ไม่ Release execution context
11. All-mode recovery ทำงานนอก `WAITING_RETRY`
12. Legacy observer เขียนทับ High-priority waiting state
13. Malformed video timestamp ถึง Network boundary

## 16. Controlled UAT ที่ยังต้องทำ

CI ไม่ใช่หลักฐานว่า Discord Mutation จริงผ่าน Production API ครบ

UAT ขั้นต่ำ:

1. Enroll Quest และตรวจ Durable lifecycle
2. Video progress พร้อม Response loss
3. Desktop heartbeat พร้อม Claim loss
4. Claim reward พร้อม Verification absent/cooldown
5. CAPTCHA และ Non-CAPTCHA HTTP 400
6. All-mode transient recovery โดยไม่ Restart process
7. สอง Worker แข่ง Scheduled row เดียวกัน
8. Worker takeover หลัง Lease expiry
9. Stop จาก Control ระหว่าง Mutation
10. Restart ระหว่าง `PREPARED`, `IN_FLIGHT`, `UNCERTAIN`, `VERIFIED`
11. Persistent storage restart/redeploy
12. Panel ยังมีเพียง `START NOW / STOP ALL`

## 17. Deployment limitations

- SQLite ต้องอยู่บน Storage ที่ทุก Process เข้าถึงไฟล์เดียวกันอย่างเชื่อถือได้
- ไม่รองรับ Workers ที่มี Database คนละไฟล์
- ไม่รับประกัน Production readiness จน Controlled UAT และ Persistent restart ผ่าน
- PR ต้องคง Draft และห้าม Merge จน External analysis, Review และ UAT ครบ
