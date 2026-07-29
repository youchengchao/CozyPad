@echo off
rem CozyPad desktop - real SSH mode. Double-click to launch.
set "PATH=C:\Program Files\nodejs;%APPDATA%\npm;%PATH%"
cd /d "%~dp0"
set COZYPAD_MOCK=0
call pnpm --filter @cozypad/desktop start
if errorlevel 1 pause
