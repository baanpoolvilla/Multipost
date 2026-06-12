@echo off
cd /d "%~dp0"
echo ========================================
echo   MultiPost Desktop Agent - Setup
echo ========================================
echo.

where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [!] Node.js not found - downloading LTS automatically...
    echo     This may take 1-3 minutes...
    echo.

    powershell -NoProfile -ExecutionPolicy Bypass -Command "$r=Invoke-RestMethod 'https://nodejs.org/dist/index.json' -UseBasicParsing;$v=($r|?{$_.lts}|select -First 1).version;$u='https://nodejs.org/dist/'+$v+'/node-'+$v+'-x64.msi';Write-Host('[i] Downloading Node.js '+$v+'...');Invoke-WebRequest -Uri $u -OutFile $env:TEMP\node_installer.msi -UseBasicParsing;Write-Host('[OK] Download complete')"

    if %errorlevel% neq 0 (
        echo [!] Download failed.
        echo     Please install Node.js manually: https://nodejs.org
        pause
        exit /b 1
    )

    echo [i] Installing Node.js (may ask for Administrator permission)...
    msiexec /i "%TEMP%\node_installer.msi" /quiet /norestart
    del "%TEMP%\node_installer.msi" >nul 2>&1

    for /f "usebackq tokens=2,*" %%a in (
        `reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v Path 2^>nul`
    ) do set "SYS_PATH=%%b"
    if defined SYS_PATH set "PATH=%SYS_PATH%;%PATH%"

    where node >nul 2>&1
    if %errorlevel% neq 0 (
        echo [OK] Node.js installed.
        echo [i] Please close and re-run this file once more.
        pause
        exit /b 0
    )
    echo [OK] Node.js ready.
    echo.
)

for /f "tokens=*" %%v in ('node -v') do set NODE_VER=%%v
echo [OK] Node.js %NODE_VER%

echo.
echo [1/2] Installing dependencies...
call npm install
if %errorlevel% neq 0 (
    echo [!] npm install failed.
    pause
    exit /b 1
)

echo.
echo [2/2] Installing Chromium for Playwright...
call npm run setup
if %errorlevel% neq 0 (
    echo [!] Playwright setup failed.
    pause
    exit /b 1
)

echo.
echo ========================================
echo   Setup complete!
echo   Double-click "เปิด Agent.bat" to start.
echo ========================================
echo.
pause
