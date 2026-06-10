@echo off
cd /d "%~dp0"
echo Starting MultiPost Desktop Agent...
npm start
echo.
echo Agent exited (code: %errorlevel%)
pause
