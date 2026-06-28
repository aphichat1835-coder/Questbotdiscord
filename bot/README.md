# NeverDie Quest Bot

Discord bot สำหรับจัดการ Quest Tracker ใน server

## Setup

### 1. ติดตั้ง dependencies

```bash
cd bot
npm install
```

### 2. ตั้งค่า environment variables

```bash
cp .env.example .env
```

แก้ไฟล์ `.env`:

| ตัวแปร | คำอธิบาย |
|---|---|
| `DISCORD_BOT_TOKEN` | Token จาก Discord Developer Portal |
| `DISCORD_CLIENT_ID` | Application ID ของบอท |
| `DISCORD_GUILD_ID` | Server ID ที่จะ register commands |
| `OWNER_ID` | Discord User ID ของเจ้าของบอท |
| `DATABASE_PATH` | path ไฟล์ JSON (default: `./data/quests.json`) |
| `TIMEZONE` | timezone (default: `Asia/Bangkok`) |

### 3. Register slash commands

```bash
npm run register
```

### 4. รันบอท

```bash
npm start
```

หรือ dev mode (restart อัตโนมัติ):

```bash
npm run dev
```

## คำสั่ง

| คำสั่ง | คำอธิบาย |
|---|---|
| `/ping` | เช็กว่าบอทออนไลน์อยู่ไหม |
| `/help` | แสดงคำสั่งทั้งหมด |
| `/quest-add name: ... deadline: ... note: ...` | เพิ่มเควสใหม่ |
| `/quest-list` | ดูรายการเควสทั้งหมด |
| `/quest-done id: ...` | มาร์คเควสว่าเสร็จแล้ว |
| `/quest-remove id: ...` | ลบเควสออก |
| `/quest-status` | ดูสรุปสถิติ |

## Bot Hosting

ตั้ง start command เป็น:

```
npm start
```

ไฟล์ข้อมูลเก็บที่ `data/quests.json` (JSON file database)
