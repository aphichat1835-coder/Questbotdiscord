# Final Quest Engine Validation

เอกสารนี้เป็นหลักฐานล่าสุดของกิ่ง `aa.1` และใช้แทนตัวเลขหลักฐานเก่าในหัวข้อ Final automated evidence ของ `QUEST-ENGINE.md` และ `PRODUCTION-CHECKLIST.md` หากข้อมูลไม่ตรงกัน ให้ยึดเอกสารนี้และผล CI บน HEAD ล่าสุดเป็นหลัก

## Validated implementation

Implementation commit ที่ผ่าน Guarded full validation ก่อน Documentation sync:

`362077ea05115113a3c57dff2f40c346e851590d`

การแก้ล่าสุดครอบคลุม:

- `mutation_status=FAILED` ไม่ถูกนับเป็น Active mutation checkpoint อีกต่อไป
- Retry deadline ของ Scheduled runner ถูก Persist เป็น `WAITING_RETRY + next_action_at` ก่อน Sleep
- Live observer ยอมรับ Retry deadline และ Daily schedule หลัง Deterministic mutation failure
- Restart ระหว่าง Backoff สามารถใช้ Durable deadline แทนการเริ่มใหม่ก่อนเวลา
- LCOV ที่ส่งให้ Sonar และ Artifact ถูกกรองเหลือเฉพาะ `bot/src`
- Workflow และ Patch scripts แบบ One-shot ถูกลบออกจาก Final tree แล้ว

## Automated evidence

Guarded full validation ของ Implementation commit ผ่านครบ:

- 469/469 tests passed
- 0 failed
- 0 cancelled
- 0 skipped
- 0 todo
- Source-only LCOV: 71 files
- Source-only line coverage: 10,685/12,071 — 88.52%
- Source-only branch coverage: 2,561/3,195 — 80.16%
- Source-only function coverage: 950/1,114 — 85.28%
- Mutation baseline passed
- Critical mutation groups were killed
- Mutation scripts restored source successfully
- Sanitized Quest fixture passed
- Repository shape passed
- Backup destination boundaries passed
- Incident and storage boundaries passed
- JavaScript, MJS and Bash syntax passed
- Production dependency audit at High severity passed

## Durable retry regression coverage

Integration tests now verify:

1. Deterministic mutation failure enters `WAITING_RETRY`.
2. A failed mutation accepts and preserves the live runner Retry deadline.
3. A failed mutation no longer blocks the next Durable daily schedule.
4. Active `PREPARED`, `IN_FLIGHT`, `ACCEPTED` and `UNCERTAIN` checkpoints remain protected from Observer overwrite.
5. Oversized Discord Retry-After values preserve the full logical deadline while Node.js timers are chunked safely.

## External and production gates

The following are still validation requirements rather than confirmed source bugs:

- CI-based Sonar scan requires repository secret `SONAR_TOKEN`; the Sonar step is skipped while it is absent.
- Fresh Codacy and CodeFactor results must refer to the latest documentation HEAD.
- Controlled Discord UAT is still required for Enroll, Video progress, Desktop heartbeat, Claim, CAPTCHA/non-CAPTCHA HTTP 400, 429, restart recovery, multi-worker ownership, shutdown fault injection, persistent SQLite and backup recovery.

## Integration safety

- PR #15 remains Draft: `aa.1` → `aa`.
- Retest `aa` after PR #15 is explicitly approved and merged.
- PR #16 is static-analysis preview only: `aa.1` → `main`; never merge it.
- Do not merge, deploy, enable auto-merge or mark Ready without Controlled UAT and explicit owner approval.
