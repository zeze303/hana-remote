@echo off
chcp 65001 >nul
title hana-remote 隧道服务器

echo ========================================
echo  hana-remote 隧道服务器
echo ========================================
echo.
echo 在启动本脚本之前，请确保：
echo  1. Hanako 桌面端正在运行
echo  2. cloudflared 已安装（见下方说明）
echo  3. 已创建并配置好 tunnel
echo.

echo ─── 第一步：启动本地服务器 ───
echo.
start "hana-remote 本地服务器" /min cmd /c "cd /d %~dp0 && node server.js"
echo 本地服务器已启动，等待就绪...
timeout /t 3 /nobreak >nul

echo.
echo ─── 第二步：启动 Cloudflare Tunnel ───
echo.
echo 正在连接隧道...
cd /d %~dp0
cloudflared tunnel run hana-remote

echo.
echo 隧道已断开
pause
