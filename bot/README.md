# NeverDie Quest Bot — คู่มือการใช้งาน

Bot สำหรับทำ Discord Quest อัตโนมัติ ควบคุมผ่าน Slash Commands ใน Discord Server

---

## การติดตั้ง

```bash
npm install
cp .env.example .env
# กรอกค่าใน .env ให้ครบถ้วน
npm run register   # ลงทะเบียน Slash Commands (ทำครั้งแรก)
npm start          # เริ่มใช้งาน
```

Repository หลักใช้ `pnpm-lock.yaml` ส่วนโฟลเดอร์ `bot` ใช้ `bot/package-lock.json`
อย่ารัน `npm install` ที่ root เพราะจะสร้าง `package-lock.json` ซ้ำและทำให้ตัวตรวจ Package Manager สับสน

---

## ตัวแปร Environment

| ตัวแปร | คำอธิบาย | จำเป็น |
|--------|----------|--------|
| `DISCORD_BOT_TOKEN` | Token ของ Bot | ✅ |
| `DISCORD_CLIENT_ID` | Application ID ของ Bot | ✅ |
| `DISCORD_GUILD_ID` | Server ID | ✅ |
| `OWNER_ID` | Discord User ID ของเจ้าของ | ✅ |
| `TIMEZONE` | Timezone (ค่าเริ่มต้น: `Asia/Bangkok`) | ➖ |
| `LOG_CHANNEL_ID` | ห้องรับการแจ้งเตือน | ➖ |
| `MANAGER_ROLE_ID` | Role สำหรับผู้จัดการ | ➖ |
| `DATABASE_PATH` | ที่อยู่ไฟล์ DB (ค่าเริ่มต้น: `./data/quests.db`) | ➖ |
| `DATABASE_BACKUP_DIR` | โฟลเดอร์ Persistent Disk สำหรับ backup SQLite รายวันเวลา 03:00 | ➖ |
| `DATABASE_BACKUP_RETENTION` | จำนวน backup ล่าสุดที่เก็บไว้ (ค่าเริ่มต้น: `7`) | ➖ |
| `GITHUB_TOKEN` | Fine-grained GitHub token สำหรับเพิ่ม API rate limit (Public repositories: read-only) | ➖ |
| `RUNNER_TOKEN_SECRET` | Secret อย่างน้อย 16 ตัวอักษร สำหรับเข้ารหัส Token ของ Auto Daily Runner | ✅ สำหรับ `/run` |

---

## คำสั่งทั้งหมด

### ทั่วไป
- `/ping` — ตรวจสอบสถานะ Bot
- `/help` — แสดงรายการคำสั่ง
- `/api-status` — ตรวจสอบสถานะฐานข้อมูลและ Runner

### Quest Runner
- `/panel` — แผงควบคุมหลัก พร้อมปุ่ม Start / Stop / Refresh และจัดการ Quest ครบชุด
- `/run` — เริ่ม Auto Daily Runner และรายงานสถานะในห้องที่ใช้คำสั่ง
- `/stop` — เปิดแผงส่วนตัวเพื่อเลือกหยุด Auto Daily Runner ทีละหลาย Token หรือทั้งหมด

### โหมด Runner

| ช่องทาง | รูปแบบ | เมื่อไม่พบ Quest |
|---|---|---|
| `/panel` → `START NOW` | One-shot | หยุด Runner และทิ้ง Token จากหน่วยความจำ |
| `/run` | Auto Daily | รอรอบ 00:00, 08:00, 16:00 ตาม `TIMEZONE` จนกว่าจะสั่ง `/stop` |

หลัง Auto Daily ทำ Quest แล้ว ระบบจะตรวจย้ำ 3 ครั้ง ห่างกันครั้งละ 5 นาที
หากพบ Quest ใหม่ระหว่างตรวจย้ำจะทำทันทีและเริ่มนับการตรวจย้ำใหม่

Token ของ Auto Daily ถูกเข้ารหัสด้วย AES-256-GCM ก่อนเก็บใน SQLite และกู้คืนอัตโนมัติหลัง restart
ควรตั้ง `DATABASE_PATH` ไปยัง Persistent Disk ของผู้ให้บริการ และห้ามเปลี่ยน
`RUNNER_TOKEN_SECRET` ขณะที่ยังมี Runner ที่บันทึกอยู่ มิฉะนั้นระบบจะถอดรหัส Token เดิมไม่ได้

หากตั้ง `DATABASE_BACKUP_DIR` ระบบจะสำรอง SQLite ทุกวันเวลา 03:00 ตาม `TIMEZONE`
และลบไฟล์เก่าให้เหลือตาม `DATABASE_BACKUP_RETENTION` ตัวอย่างบน Render:

```env
DATABASE_PATH=/var/data/quests.db
DATABASE_BACKUP_DIR=/var/data/backups
DATABASE_BACKUP_RETENTION=7
```

Discord API requests มี timeout 15 วินาที รองรับ `Retry-After` เมื่อเจอ 429
และ retry แบบ exponential backoff สำหรับ network/5xx สูงสุด 3 ครั้ง
หาก Token ตอบ 401 หรือ endpoint หลักตอบ 403 ระบบจะหยุด Runner และลบ schedule ทันที

### วิธีตรวจว่า Discord รับผลจริง

- ระบบถือว่า Quest เสร็จและรายงาน `100%` เฉพาะเมื่อดึงข้อมูลใหม่แล้วพบ `completed_at`
- ระบบ Claim รางวัลแบบเงียบ และบันทึกเวลายืนยัน `claimed_at` ไว้ให้ตรวจผ่าน `/api-status`
- ระบบเลือกเลข platform จาก `rewards_config.platforms`; หาก Claim ไม่ได้หรือพบ CAPTCHA
  จะปล่อยผ่านโดยไม่แจ้งเตือนและพักการลองซ้ำ เพื่อให้เจ้าของเข้ามารับรางวัลเอง
- ระบบรายงาน 25% / 50% / 75% / 100% จาก `user_status.progress` ที่ดึงกลับจาก Discord
  ไม่ใช่การนับเวลาในเครื่อง Bot
- ใช้ `/api-status` ดูเวลาที่ Quest API สำเร็จล่าสุด, schema/event ที่ไม่รู้จัก
  endpoint ที่ใช้งานจริง และเวลาที่ Discord ยืนยัน progress/การจบ/รับรางวัลล่าสุด
- หาก Discord เปลี่ยน response จาก array เป็นรูปแบบอื่น ระบบจะแจ้ง compatibility error
  แทนการรายงานผิดว่า “ไม่พบ Quest”
- การดึงรายการใช้ `/quests/@me` เป็นหลัก รองรับทั้ง response แบบ array และ `{ quests: [] }`
  และตรวจ `/users/@me/quests` เป็น fallback หาก endpoint หลักใช้ไม่ได้หรือส่งรายการว่าง
- รองรับ `excluded_quests` และ `quest_enrollment_blocked_until`; เควสที่ยังรับไม่ได้จะไม่ถูกนับ
  และระบบจะไม่ยิง enroll ซ้ำจนกว่า Discord จะเปิดให้รับ
- ระบบรายงานเฉพาะจำนวน Quest ที่ทำได้ เลือกทำทีละหนึ่ง Quest แล้วดึงรายการใหม่ทันที
  วนต่อจนจำนวน Quest ที่ทำได้เหลือศูนย์

สถานะนี้เก็บในหน่วยความจำ จึงเริ่มเป็น “ยังไม่มีการตรวจ” ทุกครั้งที่ Bot restart
และจะมีหลักฐานจริงหลังจาก Runner ตรวจด้วย Token และ Quest จริงแล้วเท่านั้น

### ตรวจหลัง Discord อัปเดต หรือเมื่อระบบผิดปกติ

- ตรวจ `Discord Client Version`, Build Number และ Chrome/Electron version
- ตรวจว่า Endpoint รายการ Quest ยังตอบที่ `/quests/@me` หรือ `/users/@me/quests`
- ตรวจรูปแบบ `task_config`, `task_config_v2`, `user_status.progress`,
  `completed_at` และ `claimed_at`
- ตรวจชื่อ Event ใหม่ รวมถึงหน่วยของ `target` และ progress
- ตรวจ payload ของ enroll, video-progress, heartbeat และ claim
- ตรวจ eligibility เช่น Quest หมดเวลา, ยังไม่เริ่ม, enrollment blocked หรือ excluded
- ตรวจ API version, headers และค่า `X-Super-Properties`
- ตรวจ HTTP `401/403`, Rate Limit `429`, timeout, network error และ Discord 5xx
- ตรวจตารางเวลา, timezone, Scheduled Job, Render deploy และ Persistent Disk
- หลังแก้ไขต้องรัน Bot tests/CI, deploy แล้วทดสอบด้วย Quest จริงอย่างน้อยหนึ่งตัว

### ดูอาการแล้วแก้ตรงไหน

| อาการ | จุดที่ควรตรวจ |
|---|---|
| Discord มี Quest แต่ Runner รายงาน `0 QUESTS` | Endpoint รายการ Quest, response schema, task/event parser และ eligibility filter |
| พบ Quest แต่รับ Quest ไม่ได้ | enroll endpoint/payload และ `quest_enrollment_blocked_until` |
| เริ่มทำแล้ว progress ค้าง `0%` | video-progress หรือ heartbeat payload, progress key และหน่วย target |
| Progress เพิ่มแต่ไม่ถึง `100%` | ค่าที่ Discord ตอบกลับ, timing, Rate Limit และเงื่อนไขของ Quest |
| ถึงเป้าหมายแต่ไม่จบ | ตรวจว่า Discord ส่ง `completed_at` หรือไม่ |
| จบแล้วแต่ไม่ได้รางวัล | claim endpoint/payload และ `claimed_at`/`orb_quantity_claimed` |
| `/api-status` แสดง `unknown event` | เพิ่ม parser/Runner สำหรับ Event ใหม่ หากประเภทนั้นทำผ่าน API ได้จริง |
| ได้ `401` | Token ถูกปฏิเสธหรือหมดอายุ ระบบจะหยุด Runner |
| ได้ `403` | ตรวจ Token, endpoint, headers, client/build version และสิทธิ์ของ action |
| ได้ `429` | ลดความถี่และตรวจ `Retry-After`; ห้ามยิง request ซ้ำถี่ขึ้น |
| API เป็น `incompatible` หรือ `schema changed` | เก็บ response ที่ลบ Token/ข้อมูลส่วนตัว แล้วอัปเดต parser และ test fixture |
| Scheduled Runner ไม่ทำงานตามเวลา | ตรวจ timezone, `next_check_at`, ฐานข้อมูล, Persistent Disk และ Render restart |
| แก้โค้ดแล้วระบบออนไลน์ยังเหมือนเดิม | ตรวจว่า branch/commit ที่แก้ถูก merge และ Render deploy commit ล่าสุดแล้ว |

> Quest endpoints ที่ Runner ใช้ไม่ได้อยู่ใน Discord Bot API สาธารณะ และการใช้ User Token
> ทำงานอัตโนมัติมีความเสี่ยงต่อบัญชี ไม่มีระบบใดรับประกันความเข้ากันได้หรือความปลอดภัยของบัญชีได้ 100%

สร้าง secret ที่แข็งแรงได้ด้วย:

```bash
openssl rand -hex 32
```

---

## Quest Type ที่รองรับ

Bot สามารถทำ Quest ผ่าน API ได้เฉพาะประเภทต่อไปนี้:

| Event Type | วิธีทำ | รองรับ |
|---|---|---|
| `WATCH_VIDEO` | ส่ง video-progress ช่วงเล็กทุก 10 วินาทีและอ่าน progress กลับ | ✅ |
| `WATCH_VIDEO_ON_MOBILE` | ส่ง video-progress ช่วงเล็กและตรวจผลจากเซิร์ฟเวอร์ | ✅ |
| `STREAM_ON_DESKTOP` | ต้องมี stream session จริง | ❌ ข้าม |
| `PLAY_ON_DESKTOP` | ส่ง `stream_key` heartbeat และ fallback `application_id` เมื่อจำเป็น | ✅ |
| `PLAY_ON_DESKTOP_V2` | ส่ง `stream_key` heartbeat และ fallback `application_id` เมื่อจำเป็น | ✅ |
| `ACHIEVEMENT_IN_GAME` | ต้องเล่นเกมจริง | ❌ ข้าม |
| `ACHIEVEMENT_IN_ACTIVITY` | ต้องเล่น Activity จริง | ❌ ข้าม |
| `PLAY_ACTIVITY` | ต้องเล่น Discord Activity จริง | ❌ ข้าม |
| `PLAY_ON_XBOX` / `PLAY_ON_PLAYSTATION` | ต้องเล่นบน console จริง | ❌ ข้าม |

Quest ที่ไม่รองรับจะไม่ถูกนับหรือแสดงในข้อความ Runner และระบบจะทำเฉพาะ Quest ที่รองรับ

`STREAM_ON_DESKTOP` ไม่สามารถรับประกันด้วย Token อย่างเดียว เพราะ Discord ต้องผูก heartbeat
กับ stream session จริง ระบบจึงไม่ส่ง heartbeat เปล่าและไม่รายงานผลสำเร็จปลอม

---

## ระบบ Auto-Update (ทำงานอัตโนมัติ ไม่ต้องแตะ)

Bot จะดึงค่าล่าสุดจากอินเทอร์เน็ตทุกครั้งที่ start และ refresh ทุก 6 ชั่วโมง:

| ค่า | ดึงจาก | อัปเดตบ่อยแค่ไหน |
|---|---|---|
| `CLIENT_BUILD_NUMBER` | Discord-Datamining GitHub | ทุก 2–5 วัน |
| `CHROME_VERSION` | Electron GitHub Releases | ทุก 2–3 เดือน |
| `ELECTRON_VERSION` | Electron GitHub Releases | ทุก 2–3 เดือน |
| `sec-ch-ua` header | Generate จาก Chrome version | อัตโนมัติตาม Chrome |

แนะนำให้ตั้ง `GITHUB_TOKEN` ใน Render Environment เพื่อป้องกัน rate limit จาก IP ที่ใช้งานร่วมกัน
โดยใช้ Fine-grained token สิทธิ์ `Public repositories: read-only` และห้ามบันทึก token ลง Git

**ถ้า fetch ไม่ได้** (GitHub ล่ม / rate limit) → ใช้ค่า hardcode เป็น fallback โดยอัตโนมัติ — Bot ไม่ crash

Build/header ที่อัปเดตสำเร็จไม่ได้ยืนยันว่า Quest schema หรือ action endpoint ยังทำงาน
ให้ยึดผลจาก `/api-status`, `completed_at` และ `claimed_at` เป็นหลัก

Log ที่จะเห็นทุกครั้งที่ start:
```
🔄 Build info — Client: 1.0.9267 | Build: 572743 ✨ | Chrome: 150.0.7871.46 | Electron: 43.0.0 ✨
```
เครื่องหมาย ✨ หมายความว่าค่านั้นอัปเดตเป็นเวอร์ชันใหม่กว่าครั้งก่อน

---

## สิ่งที่ต้องอัปเดตเอง

### 🔴 สำคัญมาก — อัปเดตเมื่อ Bot ถูก Block หรือ Quest ไม่สำเร็จ

#### `CLIENT_VERSION` — Discord Windows App Version
ค่าปัจจุบัน: `1.0.9267` (ใน `bot/src/discord-runner.js` บรรทัด `FALLBACK`)

**เปลี่ยนบ่อยแค่ไหน:** ทุก 2–3 เดือน  
**วิธีหาค่าใหม่:**
1. ดาวน์โหลด Discord ล่าสุดที่ [discord.com/download](https://discord.com/download)
2. เปิด Discord แล้วกด `Ctrl+R` เพื่อ refresh
3. กด `Ctrl+Shift+I` เปิด DevTools → Console พิมพ์:
   ```js
   window.DiscordNative.app.getVersion()
   ```
4. นำค่าที่ได้ไปแก้ใน `FALLBACK.clientVersion`

---

### 🟡 ปานกลาง — อัปเดตเมื่อ Discord ออก Client ใหม่มาก

#### `NATIVE_BUILD_NUMBER`
ค่าปัจจุบัน: `47491` (ใน `bot/src/discord-runner.js` บรรทัด `FALLBACK`)

**เปลี่ยนบ่อยแค่ไหน:** ทุก 3–6 เดือน  
**วิธีหาค่าใหม่:**
1. เปิด Discord Desktop → `Ctrl+Shift+I` → Console
2. พิมพ์:
   ```js
   window.DiscordNative.crashReporter.getMetadata()
   ```
   หรือดูจาก `X-Super-Properties` header ใน Network tab (decode base64)

**หมายเหตุ:** ค่านี้ Discord ไม่ได้ validate เข้มงวด ถ้าปล่อยไว้ไม่อัปเดตก็ยังทำงานได้ปกติ

---

### 🟢 ต่ำ — อัปเดตเมื่อ Discord เปลี่ยน API โครงสร้างใหญ่

#### `discord.js` library version
**วิธีอัปเดต:**
```bash
cd bot
npm install discord.js@latest
```
แล้ว check breaking changes ที่ [discord.js.org/docs](https://discord.js.org/docs)

#### `DISCORD_API` endpoint version
ปัจจุบันใช้ `v9` — Discord ยังไม่ deprecate แต่อาจเปลี่ยนในอนาคต  
แก้ใน `bot/src/discord-runner.js` บรรทัดแรก: `const DISCORD_API = 'https://discord.com/api/v9'`

---

## ตารางการบำรุงรักษา

| ช่วงเวลา | ทำอะไร | วิธี |
|---|---|---|
| **ทุกวัน** | ไม่ต้องทำอะไร — auto-update ทำให้ | — |
| **ทุก 1–2 เดือน** | ตรวจ log ว่า `BUILD_NUMBER` ยังอัปเดตอยู่ไหม | ดู Render logs |
| **ทุก 2–3 เดือน** | อัปเดต `CLIENT_VERSION` ตามด้านบน | แก้ `FALLBACK.clientVersion` |
| **ทุก 3–6 เดือน** | ตรวจว่า Quest ยังทำได้อยู่ไหม ถ้าไม่ได้อาจต้องดู API changes | ดู log หลัง `/run` |
| **เมื่อ Bot ถูก Block** | ดู [สัญญาณเตือน](#สัญญาณเตือนว่าต้องอัปเดต) ด้านล่าง | — |

---

## สัญญาณเตือนว่าต้องอัปเดต

หากเห็นสิ่งต่อไปนี้ใน log แสดงว่า Discord อาจ block client เก่าแล้ว:

```
❌ Discord API 401
❌ Discord API 403
⚠️ ERROR Invalid token
```

**ขั้นตอนแก้:**
1. ตรวจว่า User Token ยังถูกต้องอยู่ไหม (อาจถูก reset)
2. อัปเดต `CLIENT_VERSION` และ `NATIVE_BUILD_NUMBER` ตามวิธีด้านบน
3. ตรวจ `CLIENT_BUILD_NUMBER` — ถ้า auto-fetch ทำงานอยู่ค่านี้จะอัปเดตเองแล้ว
4. Redeploy บน Render

---

## วิธี Push อัปเดตไป Render

```bash
# แก้ไขไฟล์ที่ต้องการ แล้ว:
git add -A
git commit -m "update: <อธิบายสิ่งที่เปลี่ยน>"
git push origin main
# Render จะ auto-deploy ภายใน 1–2 นาที
```

---

## ระบบแจ้งเตือน

เมื่อตั้งค่า `LOG_CHANNEL_ID` ระบบจะแจ้งเตือนอัตโนมัติ:

- **ทุก 1 ชั่วโมง** — Quest ที่เกิน Deadline หรือใกล้ถึงกำหนด
- **ทุกวัน 08:00 น.** — Daily Summary สรุปสถานะ Quest ประจำวัน

---

## ฐานข้อมูล

ใช้ `better-sqlite3` เก็บข้อมูลที่ `DATABASE_PATH`

> **หมายเหตุ:** หากระบบ Host มี ephemeral filesystem ควร mount persistent disk เพื่อป้องกันข้อมูลสูญหายเมื่อ redeploy
