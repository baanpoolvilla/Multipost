@echo off
cd /d "%~dp0"
title MultiPost Agent - Setup
echo =============================================
echo   MultiPost Desktop Agent - Setup
echo =============================================
echo.

:: Check Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [!] ไม่พบ Node.js บนเครื่องนี้
    echo.
    echo     กรุณาติดตั้ง Node.js ก่อน:
    echo     1. เปิดเว็บ https://nodejs.org
    echo     2. ดาวน์โหลด LTS version กด Install
    echo     3. ปิด CMD นี้แล้วรัน ติดตั้ง.bat ใหม่
    echo.
    start https://nodejs.org
    pause
    exit /b 1
)

for /f "tokens=*" %%v in ('node -v 2^>nul') do set NODE_VER=%%v
echo [OK] Node.js %NODE_VER%
echo.

echo [1/2] ติดตั้ง dependencies (npm install)...
echo       อาจใช้เวลา 1-3 นาที โปรดรอ...
echo.
call npm install
if %errorlevel% neq 0 (
    echo.
    echo [!] npm install ล้มเหลว
    echo     ลองปิด antivirus ชั่วคราวแล้วรันใหม่
    pause
    exit /b 1
)
echo.
echo [OK] Dependencies พร้อมแล้ว
echo.

echo [2/2] ติดตั้ง Chromium สำหรับเปิด Facebook...
echo       อาจใช้เวลา 3-10 นาที โปรดรอ...
echo.
call npm run setup
if %errorlevel% neq 0 (
    echo.
    echo [!] Playwright setup ล้มเหลว
    echo     ลองรันคำสั่งนี้ใน CMD:
    echo     cd /d "%~dp0"
    echo     npx playwright install chromium
    echo.
    pause
    exit /b 1
)
echo.
echo [OK] Chromium พร้อมแล้ว
echo.

echo =============================================
echo   ติดตั้งสำเร็จ!
echo   ปิดหน้าต่างนี้แล้วดับเบิ้ลคลิก
echo   "เปิด Agent.bat" เพื่อเริ่มโปรแกรม
echo =============================================
echo.
pause
