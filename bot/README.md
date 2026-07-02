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

---

## คำสั่งทั้งหมด

### ทั่วไป
- `/ping` — ตรวจสอบสถานะ Bot
- `/help` — แสดงรายการคำสั่ง
- `/api-status` — ตรวจสอบสถานะฐานข้อมูลและ Runner

### Quest Runner
- `/panel` — แผงควบคุมหลัก พร้อมปุ่ม Start / Stop / Refresh และจัดการ Quest ครบชุด
- `/run` — เริ่มต้น Quest Runner
- `/stop` — หยุด Quest Runner

---

## Quest Type ที่รองรับ

Bot สามารถทำ Quest ผ่าน API ได้เฉพาะประเภทต่อไปนี้:

| Event Type | วิธีทำ | รองรับ |
|---|---|---|
| `WATCH_VIDEO` | ส่ง video-progress timestamp | ✅ |
| `WATCH_VIDEO_ON_MOBILE` | ส่ง video-progress timestamp | ✅ |
| `STREAM_ON_DESKTOP` | ส่ง heartbeat | ✅ |
| `PLAY_ON_DESKTOP` | ส่ง heartbeat | ✅ |
| `PLAY_ON_DESKTOP_V2` | ส่ง heartbeat | ✅ |
| `ACHIEVEMENT_IN_GAME` | ต้องเล่นเกมจริง | ❌ ข้าม |
| `ACHIEVEMENT_IN_ACTIVITY` | ต้องเล่น Activity จริง | ❌ ข้าม |
| `PLAY_ACTIVITY` | ต้องเล่น Discord Activity จริง | ❌ ข้าม |
| `PLAY_ON_XBOX` / `PLAY_ON_PLAYSTATION` | ต้องเล่นบน console จริง | ❌ ข้าม |

Quest ที่ข้ามจะถูก log บอกเหตุผลและข้ามไปทำอันถัดไปอัตโนมัติ

---

## ระบบ Auto-Update (ทำงานอัตโนมัติ ไม่ต้องแตะ)

Bot จะดึงค่าล่าสุดจากอินเทอร์เน็ตทุกครั้งที่ start และ refresh ทุก 6 ชั่วโมง:

| ค่า | ดึงจาก | อัปเดตบ่อยแค่ไหน |
|---|---|---|
| `CLIENT_BUILD_NUMBER` | Discord-Datamining GitHub | ทุก 2–5 วัน |
| `CHROME_VERSION` | Electron GitHub Releases | ทุก 2–3 เดือน |
| `ELECTRON_VERSION` | Electron GitHub Releases | ทุก 2–3 เดือน |
| `sec-ch-ua` header | Generate จาก Chrome version | อัตโนมัติตาม Chrome |

**ถ้า fetch ไม่ได้** (GitHub ล่ม / rate limit) → ใช้ค่า hardcode เป็น fallback โดยอัตโนมัติ — Bot ไม่ crash

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
