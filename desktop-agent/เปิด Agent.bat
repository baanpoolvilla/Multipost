@echo off
cd /d "%~dp0"
title MultiPost Agent

:: ตรวจว่ามี node_modules ไหม ถ้าไม่มีให้ติดตั้งอัตโนมัติ
if not exist "node_modules\" (
    echo ============================================
    echo   ตรวจพบการติดตั้งครั้งแรก กำลังติดตั้ง...
    echo ============================================
    echo.

    where node >nul 2>&1
    if %errorlevel% neq 0 (
        echo [!] ไม่พบ Node.js กรุณาติดตั้งก่อน
        start https://nodejs.org
        pause
        exit /b 1
    )

    echo [1/2] ติดตั้ง dependencies...
    call npm install
    if %errorlevel% neq 0 (
        echo [!] npm install ล้มเหลว
        pause
        exit /b 1
    )

    echo [2/2] ติดตั้ง Chromium...
    call npm run setup
    if %errorlevel% neq 0 (
        echo [!] Playwright setup ล้มเหลว
        pause
        exit /b 1
    )

    echo.
    echo [OK] ติดตั้งสำเร็จ กำลังเปิดโปรแกรม...
    echo.
)

start "MultiPost Agent" /MIN npm start
