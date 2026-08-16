@echo off
REM 一键启动 WorkBuddy（双击即可运行）
setlocal
cd /d "%~dp0"
start "" "http://localhost:3000"
"%~dp0dist\workbuddy-win-x64.exe" %*
endlocal
