<div align="center">

# ✨ NeverDie Quest Helper

<p align="center">
  <img src="src-tauri/icons/icon.png" alt="NeverDie Quest Helper Logo" width="150">
</p>

**ระบบจัดการ Discord Quest อัตโนมัติ — ครบทั้ง Desktop App และ Discord Bot**

ดูแล Quest ทุกรายการให้คุณโดยอัตโนมัติ ไม่ว่าจะเป็น Video, Stream หรือ Game Quest  
พร้อมแผงควบคุมใน Discord Server ของคุณเอง

⭐ **ถ้าโปรเจกนี้มีประโยชน์ กด Star ให้ด้วยนะครับ!** ⭐

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-22-green.svg)](https://nodejs.org/)
[![discord.js](https://img.shields.io/badge/discord.js-14-5865f2.svg)](https://discord.js.org/)
[![Express](https://img.shields.io/badge/express-4-black.svg)](https://expressjs.com/)
[![Tauri](https://img.shields.io/badge/tauri-2-blue.svg)](https://tauri.app/)
[![Vue](https://img.shields.io/badge/vue-3.5-green.svg)](https://vuejs.org/)

</div>

---

## 📖 ภาพรวมระบบ

โปรเจกนี้ประกอบด้วย **3 ส่วนหลัก** ที่ทำงานร่วมกัน:

```
Discord Server
      ↓  /run /panel /quest-add ...
  🤖 bot/          Discord Bot (discord.js)
      ↓  HTTP REST
  🔌 api/          API Server (Express + SQLite)
      ↓  discord.com/api/v9
  🎮 Quest Automation
      ↑
  🖥️  src-tauri/   Desktop App (Tauri + Vue + Rust)
```

| ส่วน | เทคโนโลยี | หน้าที่ |
|------|-----------|---------|
| `bot/` | discord.js 14, Node.js | แผงควบคุมใน Discord, รับคำสั่ง slash |
| `api/` | Express, SQLite, Node.js | API กลาง, ระบบ Quest Runner |
| `src-tauri/` | Tauri 2, Vue 3, Rust | Desktop App สำหรับจัดการเต็มรูปแบบ |

---

## 🤖 Discord Bot

### ติดตั้งและใช้งาน

**1. ตั้งค่า Environment**

```bash
cd bot
cp .env.example .env
```

แก้ไฟล์ `bot/.env`:

| ตัวแปร | คำอธิบาย |
|--------|---------|
| `DISCORD_BOT_TOKEN` | Token ของบอทจาก [Discord Developer Portal](https://discord.com/developers) |
| `DISCORD_CLIENT_ID` | Application ID ของบอท |
| `DISCORD_GUILD_ID` | Server ID ที่จะใช้งาน |
| `OWNER_ID` | Discord User ID ของเจ้าของ |
| `API_URL` | URL ของ API Server เช่น `https://your-api.com` |
| `API_SECRET` | Secret key สำหรับเชื่อมต่อ API |
| `TIMEZONE` | Timezone (default: `Asia/Bangkok`) |

**2. ติดตั้ง dependencies**

```bash
npm install
```

**3. Register Slash Commands** (ทำครั้งเดียว)

```bash
npm run register
```

**4. เริ่มใช้งาน**

```bash
npm start          # production
npm run dev        # development (auto-restart)
```

---

### 📋 คำสั่งทั้งหมด

#### 🎮 Quest Runner — อัตโนมัติ

| คำสั่ง | คำอธิบาย |
|--------|---------|
| `/run` | เปิดหน้าต่างกรอก token แล้วเริ่มทำ quest ทุกอันอัตโนมัติ |
| `/stop` | หยุด Quest Runner ที่กำลังทำงานอยู่ |
| `/panel` | เปิดแผงควบคุมพร้อมปุ่มกดครบชุด |

#### 📝 Quest Tracker — จัดการเอง

| คำสั่ง | คำอธิบาย |
|--------|---------|
| `/quest-add` | เพิ่ม quest ใหม่ พร้อม deadline และโน้ต |
| `/quest-list` | ดูรายการ quest ทั้งหมด |
| `/quest-done id:...` | มาร์ค quest ว่าเสร็จแล้ว |
| `/quest-remove id:...` | ลบ quest ออกจากรายการ |
| `/quest-status` | ดูสรุปสถิติทั้งหมด |

#### 🔧 ทั่วไป

| คำสั่ง | คำอธิบาย |
|--------|---------|
| `/ping` | เช็กว่าบอทออนไลน์อยู่ไหม |
| `/help` | แสดงคำสั่งทั้งหมด |

---

### 🎛️ แผงควบคุม `/panel`

พิมพ์ `/panel` ในห้อง Discord จะได้แผงควบคุมพร้อมปุ่มกด:

```
┌──────────────────────────────────────────┐
│  🎮 NeverDie Quest — แผงควบคุม           │
│  📦 ทั้งหมด: 5  ✅ เสร็จ: 3  🔴 ค้าง: 2  │
├──────────────────────────────────────────┤
│ [📋 ดูรายการ] [➕ เพิ่ม Quest]            │
│ [✅ Mark Done] [📊 สถิติ]                 │
│ [⚡ Start Runner] [🛑 Stop] [🔄 Refresh]  │
└──────────────────────────────────────────┘
```

ทุกปุ่มทำงานได้ทันที ไม่ต้องพิมพ์คำสั่งใหม่

---

### ⚡ Quest Runner — Flow อัตโนมัติ

เมื่อกด `/run` หรือปุ่ม **Start Runner** ในแผง:

```
1. 🔍 เช็ค quest ทั้งหมดในบัญชี
2. 📋 แสดงแผนการทำ quest แต่ละรายการ
3. 📥 Enroll quest ที่ยังไม่ได้รับ
4. ▶️  ทำ quest ที่ 1 → อัปเดต 25% → 50% → 75% → ✅
5. ▶️  ทำ quest ที่ 2, 3, ... จนครบ
6. 🔍 เช็คใหม่ว่ามี quest เพิ่มเติมไหม
7. 🎉 จบเมื่อทำ quest ทุกอันเสร็จ
```

อัปเดต progress แจ้งใน channel แบบ real-time ทุก 25%

---

## 🔌 API Server

### ติดตั้งและใช้งาน

```bash
cd api
cp .env.example .env
npm install
npm start
```

แก้ไฟล์ `api/.env`:

| ตัวแปร | คำอธิบาย |
|--------|---------|
| `PORT` | Port ที่รัน (default: `3000`) |
| `DATABASE_PATH` | Path ไฟล์ SQLite (default: `./data/quests.db`) |
| `API_SECRET` | Secret key (ต้องตรงกับ bot) |
| `DISCORD_BOT_TOKEN` | Bot token สำหรับส่งข้อความกลับ Discord |

### Endpoints

| Method | Path | คำอธิบาย |
|--------|------|---------|
| `GET` | `/health` | เช็ก status |
| `GET` | `/quests` | ดู quest ทั้งหมด |
| `GET` | `/quests/stats` | สถิติ |
| `GET` | `/quests/:id` | ดู quest ตาม ID |
| `POST` | `/quests` | เพิ่ม quest |
| `PATCH` | `/quests/:id` | แก้ไข quest |
| `PATCH` | `/quests/:id/done` | มาร์คว่าเสร็จ |
| `DELETE` | `/quests/:id` | ลบ quest |
| `POST` | `/runner/start` | เริ่ม Quest Runner |
| `POST` | `/runner/stop` | หยุด Quest Runner |
| `GET` | `/runner/status/:userId` | ดู status ของ Runner |

ทุก request ต้องส่ง header:
```
x-api-secret: <API_SECRET>
```

---

## 🖥️ Desktop App (Tauri)

แอปเดสก์ท็อปสำหรับจัดการ Quest แบบ Offline บนเครื่อง

### ความสามารถ

- 🔑 **ดึง session อัตโนมัติ** จาก Discord client บนเครื่อง
- 🎮 **Game Simulator** — จำลองการเล่นเกมสำหรับ Game Quest
- 📺 **Video & Stream Automation** — กดครั้งเดียว ระบบทำงานเบื้องหลัง
- 🔍 **Quest Filter** — กรองตามประเภท, รางวัล, สถานะ
- 👥 **หลายบัญชี** — จัดการได้หลาย account
- 🌏 **16 ภาษา** — ไทย, อังกฤษ, จีน, ญี่ปุ่น, เกาหลี และอื่น ๆ

### Architecture (Desktop App)

```
┌───────────────────────────────────────────────────────┐
│  Vue.js Frontend (Vite)                                │
│  ├─ Views: Home, GameSimulator, Settings, Debug       │
│  ├─ Stores: auth, quests, version, toast (Pinia)      │
│  └─ API: tauri.ts (IPC bridge)                        │
├───────────────────────────────────────────────────────┤
│  Rust Backend (Tauri 2)                               │
│  ├─ token_extractor.rs   — LevelDB + AES-GCM          │
│  ├─ cdp_client.rs        — Chrome DevTools Protocol   │
│  ├─ discord_api.rs       — HTTP client                │
│  ├─ quest_completer.rs   — Video/stream automation    │
│  ├─ game_simulator.rs    — Process management         │
│  └─ super_properties.rs  — Client fingerprinting      │
└───────────────────────────────────────────────────────┘
                        ↓ HTTPS
            Discord API (discord.com/api/v9)
```

---

## 🏗️ โครงสร้าง Repository

```
neverdie-quest-helper/
├── bot/                    Discord Bot
│   ├── src/
│   │   ├── commands/       slash commands ทั้งหมด
│   │   ├── index.js        entry point + event handler
│   │   ├── register-commands.js
│   │   ├── storage.js      เรียก API
│   │   └── config.js
│   ├── package.json
│   └── .env.example
│
├── api/                    API Server
│   ├── src/
│   │   ├── routes/         quests, runner
│   │   ├── index.js        Express server
│   │   ├── db.js           SQLite (better-sqlite3)
│   │   └── discord-runner.js  Quest automation engine
│   ├── package.json
│   └── .env.example
│
├── src/                    Vue.js Frontend (Desktop)
├── src-tauri/              Rust Backend (Desktop)
├── src-runner/             Game Runner binary
├── src-cdp-launcher/       CDP Launcher binary
└── .github/workflows/      CI/CD (frontend + bot + api)
```

---

## 🔒 ความปลอดภัย

- **Token ไม่ถูกบันทึก** — ใช้เฉพาะใน memory ขณะทำงาน ไม่มีการเก็บลงดิสก์
- **HTTPS ทุก request** — การสื่อสารกับ Discord เข้ารหัสตลอด
- **API Secret** — bot และ api คุยกันด้วย secret key ที่กำหนดเอง
- **Ephemeral replies** — ข้อมูล token แสดงเฉพาะผู้ใช้คนเดียวใน Discord

> **หมายเหตุ:** โปรดศึกษา Terms of Service ของ Discord ก่อนใช้งาน และใช้ด้วยความรับผิดชอบ

---

## ⚙️ CI/CD

GitHub Actions รัน 3 jobs อัตโนมัติทุก push:

| Job | ตรวจสอบอะไร |
|-----|------------|
| `frontend-checks` | i18n, unit tests, build (pnpm) |
| `bot-checks` | npm install, syntax check ทุกไฟล์ |
| `api-checks` | npm install, syntax check ทุกไฟล์ |

---

## 🤝 Contributing

ยินดีรับ Pull Request ทุกรูปแบบ! ดูรายละเอียดได้ที่ [CONTRIBUTING.md](CONTRIBUTING.md)

---

## 📄 License

MIT License — ดูที่ [LICENSE](LICENSE)

---

## 🙏 Credits

**แรงบันดาลใจและแหล่งอ้างอิง**
- [markterence/discord-quest-completer](https://github.com/markterence/discord-quest-completer)
- [power0matin/discord-quest-auto-completer](https://github.com/power0matin/discord-quest-auto-completer)
- [aamiaa/CompleteDiscordQuest.md](https://gist.github.com/aamiaa/204cd9d42013ded9faf646fae7f89fbb)
- [docs.discord.food](https://docs.discord.food/)

**เทคโนโลยีที่ใช้**

`discord.js` · `Express` · `SQLite` · `Tauri` · `Vue.js` · `Pinia` · `Rust` · `Node.js` · `TailwindCSS` · `shadcn-vue`
