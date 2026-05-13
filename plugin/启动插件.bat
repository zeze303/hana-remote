@echo off
chcp 65001 >nul
cd /d "E:\WorkSpace\Competition\hana-remote\plugin"
echo 正在连接 hana-remote 中继...
echo.
node test-connect.js
pause
