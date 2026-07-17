# รีดีไซน์ UX/UI — Multi-Post System

เอกสารสรุปผลสำรวจตลาด + ทิศทางออกแบบใหม่ (แนวโมเดิร์น SaaS สะอาดตา)
วันที่: 17 ก.ค. 2026

---

## 1. สรุปสถานะดีไซน์ปัจจุบัน

ระบบตอนนี้เป็น Express + EJS หลายหน้า (dashboard, group-post, schedule-center, history, manage-staff, audit-log ฯลฯ) ใช้ CSS ไฟล์เดียว (`public/css/style.css`)

จุดที่ควรปรับ:

- **เลียนแบบ Facebook มากเกินไป** — navbar ฟ้า #1877f2, โลโก้ทรงกลม, เลย์เอาต์ฟีด 3 คอลัมน์ ทำให้ดูเหมือน "ของก๊อป" ไม่เหมือนเครื่องมือมืออาชีพ
- **นำทางอยู่บนบน (top navbar)** — พอเมนูเยอะขึ้น (โพสต์/กลุ่ม/ตารางเวลา/ประวัติ/ทีม/ภาพรวม/log) จะอึดอัด สู้ sidebar ไม่ได้
- **สีน้ำเงินเดียวทั้งระบบ** — ไม่มีระบบสีบอกสถานะ (สำเร็จ/รอ/ล้มเหลว) ที่ชัดเจน
- **แต่ละหน้าไฟล์ EJS ใหญ่มาก** (30–55 KB) มี inline style ปนเยอะ แก้ธีมทีเดียวทั้งระบบยาก
- **ไม่มี design token** — สี/ระยะ/มุมโค้ง กระจายเป็นค่าดิบ แก้ทีต้องไล่หลายที่

จุดแข็งที่ควรเก็บไว้: composer แบบเขียนโพสต์เดียวส่งหลายเพจ, ตัวเลือกเพจแบบ chip, พรีวิว, ระบบทีม/สิทธิ์, audit log — โครงฟีเจอร์ดีอยู่แล้ว แค่ต้องแต่งหน้าใหม่

---

## 2. ผลสำรวจตลาด — คู่แข่งทำกันยังไง

สำรวจเครื่องมือ multi-post/social scheduler ชั้นนำ: Buffer, Hootsuite, Later, Publer, Metricool, SocialPilot รวมถึงตัว open-source อย่าง Postiz และ Mixpost

| เครื่องมือ | จุดเด่นด้าน UI ที่หยิบมาใช้ได้ |
|---|---|
| **Buffer** | เรียบ สะอาด เข้าใจใน 1 นาที ไม่มี learning curve — เป็นมาตรฐาน "ง่าย" ของตลาด |
| **Later** | Visual-first วางแผนด้วยปฏิทิน/กริดรูปเป็นหลัก เหมาะกับธุรกิจที่ใช้รูปเยอะ (เช่นวิลล่า) |
| **Hootsuite** | คอลัมน์ "Streams" เป็น command center — เหมาะ power user แต่ล้นง่ายสำหรับมือใหม่ |
| **Publer** | ฟีเจอร์แน่น: bulk schedule, recycle โพสต์, watermark, AI assistant ในราคาถูก |
| **Metricool** | Dashboard เน้นข้อมูล/analytics ตัดสินใจจากตัวเลข |
| **Mixpost/Postiz** | Self-host, per-platform content (ปรับข้อความรายแพลตฟอร์ม), workspace + สิทธิ์ทีม, ปฏิทินเป็นศูนย์กลาง, AI copilot |

### เทรนด์ UX/UI ปี 2026 ที่เกี่ยวข้อง

- **Function-forward / สะอาดตา** — ตลาดเบื่อ dashboard พาสเทลหน้าตาเหมือนกันหมด หันมาเน้นกริดชัด ฟังก์ชันมาก่อนการตกแต่ง
- **ลด cognitive load** — โชว์ 3–5 ตัวเลขสำคัญก่อน ที่เหลือซ่อนใน section พับได้ (progressive disclosure)
- **Dashboard = เครื่องมือตัดสินใจ** ไม่ใช่แค่โชว์ตัวเลขดิบ — ต้องไฮไลต์ insight + แนะนำ action
- **AI ในตัว** — ผู้ช่วยเขียนแคปชั่น/สร้างรูป กลายเป็นมาตรฐาน
- **Dark mode** เป็นของต้องมี

### บทสรุปทิศทาง

คู่แข่งเกือบทั้งหมด**ทิ้ง top-navbar ไปใช้ left sidebar** + พื้นที่ทำงานโล่ง ๆ สีนิ่ง มี accent สีเดียว และให้**ปฏิทินเป็นศูนย์กลาง**ของการวางแผนโพสต์ นี่คือทิศทางที่แนะนำสำหรับของเรา

---

## 3. ทิศทางที่แนะนำ — "Clean SaaS"

### 3.1 โครงเลย์เอาต์

- **Left sidebar** (พับได้) แทน top navbar — เมนู: เขียนโพสต์ · ปฏิทิน · คิวรอโพสต์ · ประวัติ · ภาพรวม · ทีมงาน · ตั้งค่า
- **พื้นที่ทำงานโล่ง** พื้นหลังสีนิ่ง (เทาอ่อน/ขาว) การ์ดขอบบาง มุมโค้ง 12px
- **ปฏิทินเป็นหน้าหลักของการจัดตาราง** — เห็นทั้งเดือน ลากวาง/คลิกช่องเพื่อสร้างโพสต์
- **Composer** = เขียนซ้าย + พรีวิวขวาแบบเรียลไทม์ (ดูตัวอย่างในภาพ mockup ด้านบน)

### 3.2 ระบบสี (Design Tokens)

เปลี่ยนจาก "ฟ้า Facebook เดียว" เป็นชุด token ที่บอกความหมาย:

```
--accent:      #4F46E5  (อินดิโก้ — ปุ่มหลัก/ลิงก์/active)
--bg:          #F8F9FB  (พื้นหลังหน้า)
--surface:     #FFFFFF  (การ์ด)
--border:      #E7E8EC  (เส้นขอบบาง)
--text:        #16181D  / --text-muted: #6B7280
--success:     #16A34A  (โพสต์สำเร็จ)
--warning:     #D97706  (รอ/กำลังคิว)
--danger:      #DC2626  (ล้มเหลว)
```

รองรับ dark mode ด้วยการสลับค่า token ชุดเดียว

### 3.3 ตัวอักษร & ระยะ

- ฟอนต์: `Inter` + `Noto Sans Thai` (คงไทยไว้)
- น้ำหนักแค่ 2 ระดับ: 400 ปกติ / 500 หนา (เลี่ยง 700 ที่ดูหนักเทอะทะ)
- ใช้ sentence case ทั้งระบบ (ไม่ ALL CAPS)
- มุมโค้ง: ปุ่ม/อินพุต 8px, การ์ด 12px; ขอบ 0.5–1px เส้นเดียวบาง ๆ

### 3.4 ไอคอน

เปลี่ยนไป Tabler icons (outline) ทั้งชุด — เส้นบาง โมเดิร์น สม่ำเสมอ แทน emoji/ไอคอนปนกัน

---

## 4. แผนปรับรายหน้า

| หน้าเดิม | ปรับเป็น |
|---|---|
| navbar ฟ้า + ฟีด 3 คอลัมน์ | Sidebar ซ้าย + workspace โล่ง |
| dashboard.ejs (composer) | Composer 2 คอลัมน์ เขียน+พรีวิวเรียลไทม์ + chip เลือกเพจ + ปุ่ม AI ช่วยเขียน |
| schedule-center / schedule-post | ปฏิทินรายเดือน คลิกช่องสร้างโพสต์ + มุมมองคิวรายวัน |
| history / group-history | ตารางสะอาด + ตัวกรอง + badge สถานะสี (สำเร็จ/รอ/ล้มเหลว) |
| overview / page-activity | Dashboard การ์ดตัวเลข 3–5 ตัวสำคัญ + กราฟ + insight |
| manage-staff | ตารางสมาชิก + badge บทบาท/สิทธิ์ |
| login | หน้า login การ์ดกลางจอ มินิมอล |

---

## 5. แนวทางลงมือ (ทำได้แบบค่อยเป็นค่อยไป ไม่พังของเดิม)

1. **สร้าง design token กลาง** — เพิ่ม `:root { --accent … }` ไว้บนสุดของ `style.css` แล้วไล่แทนค่าสีดิบทีละส่วน
2. **ทำ partial `sidebar.ejs` + `layout`** ใช้ร่วมทุกหน้า แทน navbar เดิม
3. **รีสไตล์ทีละหน้า** เริ่มจาก composer (dashboard) → ปฏิทิน → history เพราะใช้บ่อยสุด
4. **เพิ่ม dark mode** ด้วย `[data-theme="dark"]` override token
5. เก็บ logic/route/service เดิมทั้งหมด — งานนี้แตะแค่ view + css

> เพราะเป็น deploy ใช้งานจริงแล้ว แนะนำทำบน branch ใหม่ แล้วรีสไตล์ทีละหน้า ทดสอบ แล้วค่อย merge — ไม่ต้องรื้อทั้งระบบทีเดียว

---

## แหล่งอ้างอิง

- Buffer — Best Social Media Scheduling Tools 2026: https://buffer.com/resources/social-media-scheduling-tools/
- Later — Social scheduling tools tested & ranked: https://later.com/blog/social-media-scheduling-tools/
- Hootsuite — Social media dashboards templates: https://blog.hootsuite.com/social-media-dashboard/
- Postiz — Open source social media scheduler: https://postiz.com/
- Mixpost — Open source self-hosted social management: https://mixpost.app/
- Tubik Studio — UI Design Trends 2026: https://tubikstudio.com/blog/ui-design-trends-2026/
- Index.dev — UI/UX Design Trends 2026: https://www.index.dev/blog/ui-ux-design-trends
