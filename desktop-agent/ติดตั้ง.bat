@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"
powershell -NoProfile -Command "Write-Host '========================================' -ForegroundColor Cyan; Write-Host '  MultiPost Desktop Agent - ติดตั้ง' -ForegroundColor White; Write-Host '========================================' -ForegroundColor Cyan"

:: ── ตรวจสอบ Node.js ──────────────────────────────────────────
where node >nul 2>&1
if %errorlevel% neq 0 (
    powershell -NoProfile -Command "Write-Host '[!] ไม่พบ Node.js -- กำลังดาวน์โหลดอัตโนมัติ...' -ForegroundColor Yellow; Write-Host '    (ใช้เวลาประมาณ 1-3 นาที)' -ForegroundColor Gray"

    powershell -NoProfile -ExecutionPolicy Bypass -Command ^
        "try { " ^
        "  $r = Invoke-RestMethod 'https://nodejs.org/dist/index.json' -UseBasicParsing; " ^
        "  $v = ($r | Where-Object { $_.lts } | Select-Object -First 1).version; " ^
        "  $url = \"https://nodejs.org/dist/$v/node-$v-x64.msi\"; " ^
        "  Write-Host \"[i] โหลด Node.js $v ...\" -ForegroundColor Gray; " ^
        "  Invoke-WebRequest -Uri $url -OutFile \"$env:TEMP\node_installer.msi\" -UseBasicParsing; " ^
        "  Write-Host '[OK] ดาวน์โหลดสำเร็จ' -ForegroundColor Green " ^
        "} catch { Write-Host \"[!] ดาวน์โหลดล้มเหลว: $($_.Exception.Message)\" -ForegroundColor Red; exit 1 }"

    if %errorlevel% neq 0 (
        powershell -NoProfile -Command "Write-Host '[!] โหลด Node.js ไม่สำเร็จ กรุณาติดตั้งเองที่ https://nodejs.org' -ForegroundColor Red"
        pause
        exit /b 1
    )

    powershell -NoProfile -Command "Write-Host '[i] กำลังติดตั้ง Node.js (อาจขอสิทธิ์ Administrator)...' -ForegroundColor Yellow"
    msiexec /i "%TEMP%\node_installer.msi" /quiet /norestart
    del "%TEMP%\node_installer.msi" >nul 2>&1

    for /f "usebackq tokens=2,*" %%a in (
        `reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v Path 2^>nul`
    ) do set "SYS_PATH=%%b"
    if defined SYS_PATH set "PATH=%SYS_PATH%;%PATH%"

    where node >nul 2>&1
    if %errorlevel% neq 0 (
        powershell -NoProfile -Command "Write-Host '[OK] ติดตั้ง Node.js เสร็จแล้ว' -ForegroundColor Green; Write-Host '[i] กรุณาปิดแล้วเปิด ติดตั้ง.bat ใหม่อีกครั้ง' -ForegroundColor Yellow"
        pause
        exit /b 0
    )

    powershell -NoProfile -Command "Write-Host '[OK] Node.js พร้อมใช้งาน' -ForegroundColor Green"
)

for /f "tokens=*" %%v in ('node -v') do set NODE_VER=%%v
powershell -NoProfile -Command "Write-Host '[OK] Node.js %NODE_VER%' -ForegroundColor Green"

powershell -NoProfile -Command "Write-Host ''; Write-Host '[1/2] กำลังติดตั้ง dependencies...' -ForegroundColor Cyan"
call npm install
if %errorlevel% neq 0 (
    powershell -NoProfile -Command "Write-Host '[!] npm install ล้มเหลว' -ForegroundColor Red"
    pause
    exit /b 1
)

powershell -NoProfile -Command "Write-Host ''; Write-Host '[2/2] กำลังติดตั้ง Chromium สำหรับ Playwright...' -ForegroundColor Cyan"
call npm run setup
if %errorlevel% neq 0 (
    powershell -NoProfile -Command "Write-Host '[!] Playwright setup ล้มเหลว' -ForegroundColor Red"
    pause
    exit /b 1
)

powershell -NoProfile -Command "Write-Host ''; Write-Host '========================================' -ForegroundColor Green; Write-Host '  ติดตั้งเสร็จแล้ว!' -ForegroundColor Green; Write-Host '  ดับเบิลคลิก เปิด Agent.bat เพื่อเริ่มใช้งาน' -ForegroundColor White; Write-Host '========================================' -ForegroundColor Green"
pause
