@echo off
chcp 65001 >nul
title hana-remote 本地服务器

echo ========================================
echo  hana-remote 本地服务器启动
echo ========================================
echo.
echo 1. 先确保 Hanako 桌面端已启动
echo 2. 本脚本启动本地 HTTP/WS 服务器
echo 3. 再用 cloudflared 隧道暴露到公网
echo.

cd /d "%~dp0"

:start
node server.js
echo.
echo [server] 进程退出，10 秒后自动重启...
timeout /t 10 /nobreak >nul
goto start
