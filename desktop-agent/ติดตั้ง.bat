@echo off
cd /d "%~dp0"
title MultiPost Agent - Setup
echo =============================================
echo   MultiPost Desktop Agent - Setup
echo =============================================
echo.

:: ตรวจสอบ Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [!] ไม่พบ Node.js บนเครื่องนี้
    echo     กำลังติดตั้ง Node.js LTS อัตโนมัติ...
    echo.

    where winget >nul 2>&1
    if %errorlevel% equ 0 (
        winget install --id OpenJS.NodeJS.LTS -e --silent --accept-package-agreements --accept-source-agreements
        :: รีเฟรช PATH จาก registry
        for /f "tokens=*" %%p in ('powershell -NoProfile -Command "[System.Environment]::GetEnvironmentVariable(\"Path\",\"Machine\")"') do set "PATH=%%p;%PATH%"
        where node >nul 2>&1
        if %errorlevel% neq 0 (
            echo.
            echo [i] ติดตั้ง Node.js สำเร็จแล้ว
            echo     กรุณาปิดหน้าต่างนี้แล้วรัน ติดตั้ง.bat ใหม่อีกครั้ง
            echo.
            pause
            exit /b 0
        )
        echo [OK] Node.js ติดตั้งสำเร็จ
    ) else (
        echo [!] ไม่พบ winget — ติดตั้งด้วยตัวเองได้ที่ https://nodejs.org
        echo     1. ดาวน์โหลด LTS version แล้วกด Install
        echo     2. ปิด CMD นี้แล้วรัน ติดตั้ง.bat ใหม่
        echo.
        start https://nodejs.org
        pause
        exit /b 1
    )
)

for /f "tokens=*" %%v in ('node -v 2^>nul') do set NODE_VER=%%v
echo [OK] Node.js %NODE_VER%
echo.

:: ตรวจสอบ node_modules
if exist "node_modules\" (
    echo [1/2] Dependencies มีอยู่แล้ว ข้ามขั้นตอนนี้
) else (
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
    echo [OK] Dependencies พร้อมแล้ว
)
echo.

:: ตรวจสอบ Chromium (Playwright)
set "PW_DIR=%USERPROFILE%\AppData\Local\ms-playwright"
set CHROMIUM_OK=0
if exist "%PW_DIR%\" (
    for /d %%d in ("%PW_DIR%\chromium-*") do set CHROMIUM_OK=1
)

if "%CHROMIUM_OK%"=="1" (
    echo [2/2] Chromium มีอยู่แล้ว ข้ามขั้นตอนนี้
) else (
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
    echo [OK] Chromium พร้อมแล้ว
)
echo.

echo =============================================
echo   ติดตั้งสำเร็จ!
echo   ปิดหน้าต่างนี้แล้วดับเบิ้ลคลิก
echo   "เปิด Agent.bat" เพื่อเริ่มโปรแกรม
echo =============================================
echo.
pause
