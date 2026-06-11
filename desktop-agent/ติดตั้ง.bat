@echo off
cd /d "%~dp0"
echo ========================================
echo   MultiPost Desktop Agent - ติดตั้ง
echo ========================================
echo.

where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [!] ไม่พบ Node.js ^!
    echo     กรุณาดาวน์โหลดและติดตั้ง Node.js ก่อน
    echo     https://nodejs.org  ^(แนะนำ LTS version^)
    echo.
    pause
    exit /b 1
)

for /f "tokens=*" %%v in ('node -v') do set NODE_VER=%%v
echo [✓] Node.js %NODE_VER%

echo.
echo [1/2] กำลังติดตั้ง dependencies...
call npm install
if %errorlevel% neq 0 (
    echo [!] npm install ล้มเหลว
    pause
    exit /b 1
)

echo.
echo [2/2] กำลังติดตั้ง Chromium สำหรับ Playwright...
call npm run setup
if %errorlevel% neq 0 (
    echo [!] Playwright setup ล้มเหลว
    pause
    exit /b 1
)

echo.
echo ========================================
echo   ติดตั้งเสร็จแล้ว!
echo   ดับเบิลคลิก "เปิด Agent.bat" เพื่อเริ่มใช้งาน
echo ========================================
echo.
pause
