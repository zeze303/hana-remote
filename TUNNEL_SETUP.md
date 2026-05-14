# hana-remote Cloudflare Tunnel 配置指南

## 架构

```
浏览器 → https://hanako.13701.top → Cloudflare CDN → Tunnel → 本机:3456 → Hanako
```

不再需要 Render 中继。网页和插件直接通过隧道直连。

## 1. 安装 cloudflared

打开 PowerShell，运行：

```powershell
winget install --id Cloudflare.cloudflared
```

或手动下载：https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
选择 Windows 64-bit 版本，解压到 `E:\WorkSpace\Competition\hana-remote\`。

安装后重启终端，验证：

```powershell
cloudflared tunnel list
```

## 2. 登录 Cloudflare 账号

```powershell
cloudflared tunnel login
```

浏览器会自动打开，选择你的 Cloudflare 账号授权。授权成功后会下载证书文件。

## 3. 创建隧道

```powershell
cloudflared tunnel create hana-remote
```

执行后会在 `C:\Users\19133\.cloudflared\` 下生成 `hana-remote.json` 凭证文件。

## 4. 配置 DNS 指向隧道

```powershell
cloudflared tunnel route dns hana-remote hanako.13701.top
```

这样 `hanako.13701.top` 的 DNS 记录就会被 Cloudflare 自动指向你的隧道。

## 5. 验证配置文件

检查 `E:\WorkSpace\Competition\hana-remote\cloudflared.yml`：

```yaml
tunnel: hana-remote
credentials-file: C:\Users\19133\.cloudflared\hana-remote.json

ingress:
  - hostname: hanako.13701.top
    service: http://localhost:3456
  - service: http_status:404
```

## 6. 启动

双击 `启动隧道.bat` 或运行：

```powershell
cd E:\WorkSpace\Competition\hana-remote
启动隧道.bat
```

它会：
1. 自动启动本地服务器（`node server.js`）
2. 启动 Cloudflare Tunnel
3. 两者都在后台运行

## 验证成功

浏览器打开 `https://hanako.13701.top`，如果能正常显示登录页，就说明通了。

## 7. Render 下线

确认隧道工作正常后，可以去 Render Dashboard 停止 `hana-remote` 服务，不再需要它了。

## 故障排除

| 问题 | 检查 |
|------|------|
| 隧道连不上 | 确认 cloudflared 已登录 `cloudflared tunnel list` |
| 网页打不开 | 确认本地服务器在运行 `curl http://127.0.0.1:3456` |
| WebSocket 连不上 | Cloudflare Tunnel 默认支持 WS，不需要额外配置 |
| 冷启动问题 | 隧道常驻在线，不会冷启动 |
