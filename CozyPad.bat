@echo off
setlocal
cd /d "%~dp0"
set "NODE=C:\Program Files\nodejs\node.exe"
if not exist "%NODE%" set "NODE=node"
set COZYPAD_MOCK=0
"%NODE%" apps\desktop\scripts\start.mjs
if errorlevel 1 pause
