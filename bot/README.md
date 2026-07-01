# NeverDie Quest Bot (Merged)

บอท Discord + Quest Runner + Quest Tracker รวมเป็นโปรเซสเดียว ไม่ต้องรัน API แยกอีกต่อไป

## ติดตั้ง
```bash
npm install
cp .env.example .env   # แล้วกรอกค่าให้ครบ
npm run register       # ลง slash command ครั้งแรก (หรือทุกครั้งที่แก้คำสั่ง)
npm start               # รันบอท
```

## คำสั่งทั้งหมด
- `/panel` — แผงควบคุมหลัก มีปุ่ม: รายการ / เพิ่ม / Done / แก้ไข / ลบ / สถิติ / 🪙 กรอก Token-Start Runner / 🛑 Stop Runner / Refresh
- `/run` — เปิด modal กรอก Discord User Token แล้วเริ่มทำเควสอัตโนมัติทันที
- `/stop` — หยุด Runner ที่กำลังทำงาน
- `/quest-add /quest-list /quest-done /quest-remove /quest-status` — จัดการ quest tracker (คนละเรื่องกับ Runner อัตโนมัติ ไว้ track เควส/deadline เอง)
- `/api-status` — เช็คสถานะฐานข้อมูลและจำนวน Runner job ที่กำลังทำงาน
- `/ping /help`

## ระหว่าง Runner ทำงาน
บอทจะส่งข้อความ embed **1 ข้อความ** ในห้องที่สั่ง แล้ว **edit ข้อความเดิมต่อเนื่อง** (ไม่สแปมห้อง) แสดง:
- จำนวนเควสที่พบทั้งหมด
- เควสที่กำลังทำอยู่ + ลำดับ (เช่น 2/5)
- % ความคืบหน้าของเควสปัจจุบัน (progress bar)
- จำนวนเควสที่เหลือ
- เวลาที่ทำงานมาแล้ว

## หมายเหตุ
- ใช้ `better-sqlite3` เก็บข้อมูล quest tracker ไว้ที่ `DATABASE_PATH` (default `./data/quests.db`) — ถ้า host เป็นแบบ ephemeral filesystem ต้อง mount persistent disk ไม่งั้นข้อมูลหายตอน redeploy
- Discord User Token ที่กรอกผ่าน `/run` หรือปุ่มใน panel **ไม่ถูกบันทึกลง DB** อยู่ใน memory แค่ตอน job รันเท่านั้น
- การใช้ user token อัตโนมัติแบบนี้ขัดกับ Discord ToS มีความเสี่ยงโดนแบนบัญชีได้ ใช้อย่างระมัดระวัง
