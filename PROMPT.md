# Multi Post System - AI Agent Prompt

## Objective

สร้างระบบ One Click Multi Post ด้วย Node.js + Express + EJS

เวอร์ชันแรกไม่ต้องเชื่อม Facebook API จริง ให้จำลองการโพสต์โดยอ่านรายชื่อเพจจาก pages.json และแสดงผลการส่งโพสต์

## Project Structure

```text
multi-post-system/
│
├── package.json
├── server.js
│
├── routes/
│   └── postRoutes.js
│
├── controllers/
│   └── postController.js
│
├── services/
│   └── facebookService.js
│
├── data/
│   └── pages.json
│
├── public/
│   ├── css/
│   │   └── style.css
│   └── js/
│       └── app.js
│
├── views/
│   ├── dashboard.ejs
│   └── result.ejs
│
└── logs/
    └── post.log
```

## Technical Requirements

- Node.js
- Express
- EJS
- No database (use JSON file)
- Vanilla JavaScript
- Responsive UI

## Features

### Dashboard
- URL: `/`
- Textarea สำหรับกรอกข้อความ
- ปุ่ม "โพสต์ทุกเพจ"

### Submit Flow
- POST `/send`
- รับค่า `message`
- โหลดข้อมูลจาก `data/pages.json`
- วนลูปทุกเพจ
- จำลองการโพสต์ (ยังไม่เรียก Facebook API)
- บันทึก log ลง `logs/post.log`

### Result Page
- แสดงข้อความที่ส่ง
- แสดงผลลัพธ์ทุกเพจในรูปแบบตาราง

## Example pages.json

```json
[
  {
    "pageId": "1001",
    "pageName": "Pool Villa A"
  },
  {
    "pageId": "1002",
    "pageName": "Pool Villa B"
  },
  {
    "pageId": "1003",
    "pageName": "Pool Villa C"
  }
]
```

## Service Layer

facebookService.js

Function:

```js
sendToAllPages(message)
```

Responsibilities:

- Load pages.json
- Loop all pages
- Simulate posting
- Write logs
- Return result array

## Routes

```text
GET  /
POST /send
```

## Deliverables

Generate complete code for:

- package.json
- server.js
- routes/postRoutes.js
- controllers/postController.js
- services/facebookService.js
- data/pages.json
- public/css/style.css
- public/js/app.js
- views/dashboard.ejs
- views/result.ejs

Project must run with:

```bash
npm install
npm run dev
```

Open:

```text
http://localhost:3001
```

and work immediately.
