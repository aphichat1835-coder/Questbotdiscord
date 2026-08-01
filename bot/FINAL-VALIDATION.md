# Final Quest Engine Validation

เอกสารนี้เป็นหลักฐานล่าสุดของกิ่ง `aa.1` และใช้แทนตัวเลขหลักฐานเก่าใน `QUEST-ENGINE.md`, `PRODUCTION-CHECKLIST.md` และคำอธิบาย PR รุ่นก่อน หากข้อมูลไม่ตรงกัน ให้ยึดเอกสารนี้และผล CI ที่ระบุด้านล่างเป็นหลัก

## Validated implementation

Implementation commit ที่มีการเปลี่ยน Source ล่าสุด:

`807e2bed943e7bad9fe97a1aa7cfb6a88c730b0c`

Documentation-validation commit ที่ยืนยัน Source เดียวกันพร้อมเอกสารสถานะใหม่:

`b9c20cde7470bb608a670ddb9bab6d2ea8c2190b`

GitHub Actions บน Documentation-validation commit:

- CI #2146 — Success
- CI #2147 — Success
- Repository shape — Success
- Recursive tests and Source-only coverage — Success
- Critical mutation safety — Success
- Mutation source restoration — Success
- JavaScript, MJS and Bash syntax — Success
- Production dependency audit at High severity — Success

## Automated evidence

- 499/499 tests passed
- 0 failed
- 0 cancelled
- 0 skipped
- 0 todo
- Source-only LCOV: 72 files
- Source-only line coverage: 11,085/12,480 — 88.82%
- Source-only branch coverage: 2,698/3,358 — 80.35%
- Source-only function coverage: 979/1,142 — 85.73%
- Mutation baseline passed
- 15 primary critical mutations were killed
- 26 review/regression mutations were killed
- Recovery metadata mutation was killed
- Mutation scripts restored source successfully
- Sanitized Quest fixture passed
- Repository shape passed
- Backup destination boundaries passed
- Incident and storage boundaries passed
- JavaScript, MJS and Bash syntax passed
- Production dependency audit found 0 vulnerabilities at the configured High gate
- Snyk passed
- CodeRabbit passed
- SonarQube Cloud was skipped because `SONAR_TOKEN` is unavailable

## Durable retry and recovery evidence

The current implementation verifies that:

1. `FAILED` is not treated as an active mutation checkpoint.
2. Scheduled transient retries persist `WAITING_RETRY + next_action_at` before sleeping.
3. A failed mutation accepts and preserves the live retry deadline.
4. A failed mutation does not block the next durable daily schedule.
5. Active `PREPARED`, `IN_FLIGHT`, `ACCEPTED` and `UNCERTAIN` checkpoints remain protected from observer overwrite.
6. Restart recovery uses durable deadlines and verifies uncertain mutations before any resend.
7. Oversized Discord `Retry-After` values preserve the full logical deadline while Node.js timers use safe bounded chunks.
8. Completed runner jobs release their in-memory coordinator mutation lock.
9. Direct state writes and observer writes are fenced by scheduled-worker ownership.

## Live Quest transport correction

A controlled comparison found that the previously merged `aa` state discovered seven Quests but failed enrollment for all seven, while `main` completed the same seven Quests. The current `aa.1` work therefore:

- restores user Quest traffic to the working Discord API v9 behavior,
- prevents the global Discord runtime from rewriting versioned Quest URLs,
- preserves rate-limit coordination without rewriting transport,
- keeps supported Quest protocol variants fail-closed on invalid schema,
- adds integration coverage for mutation retry, verification, Smart Wake, claim retry and ownership boundaries.

Automated tests do not prove live Discord enrollment, progress or reward claiming. The same-account seven-Quest scenario must pass controlled UAT before integration.

## Repository cleanliness

- Source-only LCOV filtering is part of `npm run test:coverage`.
- Temporary one-shot workflows and patch scripts are absent from the current tree.
- The normal CI workflow has read-only repository permissions.
- `main` has not received these Quest Engine changes.

## External and production gates

Still required:

- Configure repository secret `SONAR_TOKEN` and run CI-based Sonar analysis; the Sonar step is currently skipped.
- Confirm fresh CodeFactor and Codacy results on the final integration candidate.
- Controlled Discord UAT for enrollment, video progress, desktop heartbeat and reward claim.
- CAPTCHA and non-CAPTCHA HTTP 400 validation.
- HTTP 429 above 60 seconds and queued cancellation.
- Restart during enrollment, progress and claim without duplicate mutation.
- Shared-storage multi-worker ownership, lease expiry and takeover.
- Shutdown fault injection and persistent SQLite/backup recovery.

## Integration safety

- PR #15 (`aa.1` → `aa`) was merged on 30 July 2026; it did not modify `main`.
- PR #17 is the current corrective path: `aa.1` → `aa`; it must remain Draft until controlled Discord UAT passes.
- PR #10 (`aa` → `main`) must remain Draft because the current `aa` state has a confirmed live Quest regression.
- PR #16 (`aa.1` → `main`) is static-analysis preview only and must never be merged.
- Do not merge, deploy, enable auto-merge or mark any integration PR Ready without controlled UAT and explicit owner approval.
