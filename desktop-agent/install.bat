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
    echo [!] Node.js not found. Installing Node.js LTS...
    echo.

    where winget >nul 2>&1
    if %errorlevel% equ 0 (
        winget install --id OpenJS.NodeJS.LTS -e --silent --accept-package-agreements --accept-source-agreements
        for /f "tokens=*" %%p in ('powershell -NoProfile -Command "[System.Environment]::GetEnvironmentVariable(\"Path\",\"Machine\")"') do set "PATH=%%p;%PATH%"
        where node >nul 2>&1
        if %errorlevel% neq 0 (
            echo.
            echo [i] Node.js installed. Please close this window and run install.bat again.
            echo.
            pause
            exit /b 0
        )
        echo [OK] Node.js installed successfully.
    ) else (
        echo [!] winget not found. Please install Node.js from https://nodejs.org
        echo     1. Choose LTS and click Install.
        echo     2. Close this window and run install.bat again.
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
    echo [1/3] Dependencies already exist. Skipping.
    echo.
) else (
    echo [1/3] Installing dependencies ^(npm install^)...
    echo       This may take 1-3 minutes. Please wait...
    echo.
    set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
    set npm_config_electron_mirror=https://npmmirror.com/mirrors/electron/
    call npm install
    if %errorlevel% neq 0 (
        echo.
        echo [!] npm install failed. Try disabling antivirus and run again.
        pause
        exit /b 1
    )
    echo [OK] Dependencies installed.
    echo.
)

:: ตรวจสอบ Electron binary
if not exist "node_modules\electron\dist\electron.exe" (
    echo [2/3] Electron binary missing. Downloading...
    set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
    node node_modules\electron\install.js
    if %errorlevel% neq 0 (
        echo.
        echo [!] Electron download failed. Run manually:
        echo     cd /d "%~dp0"
        echo     set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
        echo     node node_modules\electron\install.js
        echo.
        pause
        exit /b 1
    )
    echo [OK] Electron ready.
    echo.
) else (
    echo [2/3] Electron already exists. Skipping.
    echo.
)

:: ตรวจสอบ Chromium (Playwright)
set "PW_DIR=%USERPROFILE%\AppData\Local\ms-playwright"
set CHROMIUM_OK=0
if exist "%PW_DIR%\" (
    for /d %%d in ("%PW_DIR%\chromium-*") do set CHROMIUM_OK=1
)

if "%CHROMIUM_OK%"=="1" (
    echo [3/3] Chromium already exists. Skipping.
) else (
    echo [3/3] Installing Chromium for browser automation...
    echo       This may take 3-10 minutes. Please wait...
    echo.
    call npm run setup
    if %errorlevel% neq 0 (
        echo.
        echo [!] Playwright setup failed. Run manually:
        echo     cd /d "%~dp0"
        echo     npx playwright install chromium
        echo.
        pause
        exit /b 1
    )
    echo [OK] Chromium ready.
)
echo.

echo =============================================
echo   Setup complete!
echo   Close this window, then double-click
echo   "start.bat" to launch the program.
echo =============================================
echo.
pause
