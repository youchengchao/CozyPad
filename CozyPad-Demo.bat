@echo off
rem CozyPad desktop - mock demo mode (no real host needed). Double-click to launch.
set "PATH=C:\Program Files\nodejs;%APPDATA%\npm;%PATH%"
cd /d "%~dp0"
set COZYPAD_MOCK=1
call pnpm --filter @cozypad/desktop start
if errorlevel 1 pause
