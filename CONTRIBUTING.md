# แนวทางการพัฒนา NeverDie Quest Bot

## เริ่มต้น

```bash
git clone https://github.com/aphichat1835-coder/Questbotdiscord.git
cd Questbotdiscord/bot
npm ci
cp .env.example .env
npm test
```

## โครงสร้างหลัก

- `bot/src/commands/` — Slash commands และ Interaction handlers
- `bot/src/discord-runner.js` — Quest engine และ Job registry
- `bot/src/runner-control.js` — Stop lifecycle และการรอ Cleanup
- `bot/src/scheduled-runner-store.js` — Scheduled Runner persistence
- `bot/src/db.js` — SQLite schema และ migration
- `bot/src/worker.js` — Database backup scheduler
- `bot/src/dashboard.js` — Health endpoint
- `bot/test/` — Regression tests

## กฎสำคัญ

- ใช้ ES Modules
- Interaction ส่วนตัวใช้ `flags: 64`
- ตรวจ Permission ที่ Action boundary
- อย่าเก็บหรือพิมพ์ Token ลง Log
- Quest เสร็จเมื่อ Discord ยืนยัน `completed_at`
- การ Claim สำเร็จเมื่อยืนยัน `claimed_at`
- Stop ต้องรอ Cleanup ก่อนเริ่มบัญชีเดิมซ้ำ
- ทุกการเปลี่ยนแปลงต้องมี Test หรือหลักฐานตรวจสอบที่เหมาะสม

## ก่อนส่ง Pull Request

```bash
cd bot
npm test
find src -name '*.js' -print0 | xargs -0 -n1 node --check
npm audit --omit=dev --audit-level=high
```
