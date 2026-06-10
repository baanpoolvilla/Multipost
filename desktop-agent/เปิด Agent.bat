@echo off
cd /d "%~dp0"
echo กำลังเปิด MultiPost Desktop Agent...
npm start
if %errorlevel% neq 0 (
    echo.
    echo เกิดข้อผิดพลาด! กรุณาตรวจสอบ error ด้านบน
    pause
)
