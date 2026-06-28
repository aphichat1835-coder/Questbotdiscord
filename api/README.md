# NeverDie Quest API

Express + SQLite API server ตัวกลางสำหรับ Quest system

## Setup

```bash
cd api
npm install
cp .env.example .env
npm start
```

## Environment Variables

| ตัวแปร | คำอธิบาย |
|---|---|
| `PORT` | port ที่รัน (default: 3000) |
| `DATABASE_PATH` | path ไฟล์ SQLite (default: `./data/quests.db`) |
| `API_SECRET` | secret key สำหรับ authenticate request |

## Endpoints

| Method | Path | คำอธิบาย |
|---|---|---|
| GET | `/health` | เช็ก status |
| GET | `/quests` | ดูเควสทั้งหมด |
| GET | `/quests/stats` | สถิติ |
| GET | `/quests/:id` | ดูเควสตาม ID |
| POST | `/quests` | เพิ่มเควส |
| PATCH | `/quests/:id` | แก้ไขเควส |
| PATCH | `/quests/:id/done` | มาร์คว่าเสร็จ |
| DELETE | `/quests/:id` | ลบเควส |

## Authentication

ทุก request ต้องส่ง header:
```
x-api-secret: <API_SECRET>
```

## POST /quests — Body

```json
{
  "name": "ทำเควส Discord Orbs",
  "deadline": "2026-07-01",
  "note": "ยังไม่ได้ทำ"
}
```
