@chcp 65001 >nul
@echo off
cd /d "%~dp0"
echo กำลังเปิด MultiPost Desktop Agent...
npm start
echo.
echo Agent ปิดแล้ว (code: %errorlevel%)
pause
