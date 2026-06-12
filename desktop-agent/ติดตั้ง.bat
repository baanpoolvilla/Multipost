@echo off
cd /d "%~dp0"
echo ========================================
echo   MultiPost Desktop Agent - ติดตั้ง
echo ========================================
echo.

:: ── ตรวจสอบ Node.js ──────────────────────────────────────────
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [!] ไม่พบ Node.js — กำลังดาวน์โหลดและติดตั้งอัตโนมัติ...
    echo     ^(ใช้เวลาประมาณ 1-3 นาที ขึ้นอยู่กับอินเทอร์เน็ต^)
    echo.

    :: ดึง URL ของ Node.js LTS เวอร์ชันล่าสุดแล้วโหลด MSI
    powershell -NoProfile -ExecutionPolicy Bypass -Command ^
        "try { " ^
        "  $r = Invoke-RestMethod 'https://nodejs.org/dist/index.json' -UseBasicParsing; " ^
        "  $v = ($r | Where-Object { $_.lts } | Select-Object -First 1).version; " ^
        "  $url = \"https://nodejs.org/dist/$v/node-$v-x64.msi\"; " ^
        "  Write-Host \"[i] โหลด Node.js $v จาก $url\"; " ^
        "  Invoke-WebRequest -Uri $url -OutFile \"$env:TEMP\node_installer.msi\" -UseBasicParsing; " ^
        "  Write-Host '[✓] ดาวน์โหลดสำเร็จ' " ^
        "} catch { Write-Host '[!] ดาวน์โหลดล้มเหลว:' $_.Exception.Message; exit 1 }"

    if %errorlevel% neq 0 (
        echo.
        echo [!] โหลด Node.js ไม่สำเร็จ
        echo     กรุณาติดตั้งเองที่ https://nodejs.org แล้วรัน ติดตั้ง.bat ใหม่
        echo.
        pause
        exit /b 1
    )

    echo.
    echo [i] กำลังติดตั้ง Node.js ^(อาจขอสิทธิ์ Administrator^)...
    msiexec /i "%TEMP%\node_installer.msi" /quiet /norestart
    del "%TEMP%\node_installer.msi" >nul 2>&1

    :: Refresh PATH จาก registry ให้ cmd session นี้เห็น node ทันที
    for /f "usebackq tokens=2,*" %%a in (
        `reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v Path 2^>nul`
    ) do set "SYS_PATH=%%b"
    if defined SYS_PATH set "PATH=%SYS_PATH%;%PATH%"

    :: ตรวจอีกครั้งหลังติดตั้ง
    where node >nul 2>&1
    if %errorlevel% neq 0 (
        echo.
        echo [✓] ติดตั้ง Node.js เสร็จแล้ว
        echo [i] กรุณา ปิดหน้าต่างนี้แล้วเปิด ติดตั้ง.bat ใหม่ 1 ครั้ง
        echo     ^(Windows ต้องการ restart terminal เพื่อรู้จัก Node.js^)
        echo.
        pause
        exit /b 0
    )

    echo [✓] Node.js พร้อมใช้งาน
    echo.
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
