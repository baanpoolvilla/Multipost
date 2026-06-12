@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"
powershell -NoProfile -Command "Write-Host 'กำลังเปิด MultiPost Desktop Agent...' -ForegroundColor Cyan"
npm start
powershell -NoProfile -Command "Write-Host 'Agent ปิดแล้ว' -ForegroundColor Gray"
pause
