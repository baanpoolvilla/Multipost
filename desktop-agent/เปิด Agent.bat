@echo off
chcp 65001 >nul
cd /d "%~dp0"
title MultiPost Agent

:: ครั้งแรก ยังไม่มี node_modules ให้ติดตั้งก่อน
if not exist "node_modules\" (
    echo ตรวจพบการติดตั้งครั้งแรก กำลังติดตั้ง...
    call "ติดตั้ง.bat"
    if %errorlevel% neq 0 exit /b 1
)

:: Auto-update: ดึง version จาก server เปรียบเทียบกับ local
echo กำลังตรวจสอบอัพเดต...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$env = @{}; if (Test-Path '.env') { Get-Content '.env' | ForEach-Object { if ($_ -match '^([^=]+)=(.*)') { $env[$Matches[1]]=$Matches[2] } } }; " ^
    "$webUrl = $env['WEB_URL']; if (-not $webUrl) { Write-Host 'ไม่พบ WEB_URL ข้ามการอัพเดต'; exit 0 }; " ^
    "try { " ^
    "  $r = Invoke-RestMethod -Uri \"$webUrl/api/agent-version\" -TimeoutSec 5; " ^
    "  $local = (Get-Content 'package.json' -Raw | ConvertFrom-Json).version; " ^
    "  if ($r.version -ne $local) { " ^
    "    Write-Host \"อัพเดตจาก $local เป็น $($r.version)...\"; " ^
    "    Invoke-WebRequest -Uri \"$webUrl/api/agent/source\" -OutFile '_update.zip' -TimeoutSec 60; " ^
    "    Add-Type -Assembly System.IO.Compression.FileSystem; " ^
    "    $z = [System.IO.Compression.ZipFile]::OpenRead('_update.zip'); " ^
    "    foreach ($e in $z.Entries) { if ($e.Name -eq '') { continue }; $d = Join-Path (Get-Location).Path $e.FullName; $dir = [IO.Path]::GetDirectoryName($d); if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }; [System.IO.Compression.ZipFileExtensions]::ExtractToFile($e,$d,$true) }; " ^
    "    $z.Dispose(); Remove-Item '_update.zip'; Write-Host 'อัพเดตสำเร็จ!' " ^
    "  } else { Write-Host 'เวอร์ชันล่าสุดแล้ว' } " ^
    "} catch { Write-Host 'ตรวจสอบอัพเดตไม่ได้ เปิดโปรแกรมต่อ...' }" 2>nul

echo กำลังเปิดโปรแกรม...
start "MultiPost Agent" /MIN npm start
