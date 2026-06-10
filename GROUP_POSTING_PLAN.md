# GROUP POSTING INTEGRATION PLAN

## Overview

ปัจจุบันระบบรองรับการโพสต์หลายเพจผ่าน Facebook Graph API ได้แล้ว

ปัญหา:
- Facebook ไม่อนุญาตให้โพสต์เข้ากลุ่มผ่าน Graph API เหมือนในอดีต
- ระบบโพสต์เข้ากลุ่มที่มีอยู่ไม่สามารถทำงานได้
- ต้องการให้ผู้ใช้กดเริ่มงานเองจากคอมพิวเตอร์
- ไม่ต้องใช้ VPS
- ทำงานเสร็จแล้วปิดได้

---

# แนวทางแก้ไข

แยกระบบออกเป็น 2 ส่วน

## 1. Page Posting System

ใช้ระบบเดิม

Dashboard
→ เลือกโพสต์
→ เลือกเพจ
→ Facebook Graph API
→ โพสต์หลายเพจ

## 2. Group Posting Agent

สร้าง Agent แยกจากระบบหลัก

Desktop Agent
- Electron
- Playwright
- Local API
- Job Runner
- Logger

---

# Architecture

Dashboard
→ สร้าง Job
→ Database
→ Desktop Agent
→ ดึง Job
→ ประมวลผล
→ อัปเดตสถานะ

---

# Database Design

## groups

```json
{
  "groupId": "",
  "groupName": "",
  "enabled": true
}
```

## jobs

```json
{
  "type": "group-share",
  "status": "pending"
}
```

---

# Future Features

- Job Queue
- Agent Monitor
- Scheduled Posting
- Multiple Accounts

