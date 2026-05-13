# hana-remote

通过浏览器远程使用 Hanako 的全部能力。工作电脑常开，手机/平板/另一台电脑随时随地连接。

**架构：** 浏览器 ↔ WSS → Render（中继） ←outbound WSS← 工作电脑插件

工作电脑不需要公网 IP，所有连接都是出方向的。

---

## 功能

| 功能 | 说明 |
|------|------|
| 文件浏览 | 全盘文件树，懒加载目录，引导线展示 |
| 代码编辑 | Monaco Editor，浏览/编辑模式，自动备份 |
| 对话 | 流式聊天，完整对话能力 |
| 搜索 | 按文件名搜索整个磁盘（深度 4 层） |
| 剪贴板互通 | 一键复制/粘贴到工作电脑 |
| 安全 | JWT 认证、IP 限流、Session 超时自动登出 |
| PWA | 可添加到手机桌面 |

---

## 快速开始

### 1. 部署 Relay 到 Render

```bash
# Fork/Clone
git clone https://github.com/zeze303/hana-remote.git
cd hana-remote/relay

# 安装依赖
npm install

# 设置环境变量（或创建 .env）
# PORT=3000
# JWT_SECRET=你的随机密钥
# WORKER_SECRET=你的工作电脑密钥（与插件配置一致）
# STATIC_DIR=public

# 启动
node index.js
```

**Render 部署：** 选 Web Service，Build Command 留空，Start Command 填 `node index.js`。

### 2. 工作电脑运行插件

```bash
cd hana-remote/plugin
npm install

# 编辑 manifest.json 或 test-connect.js
# 设置 relayUrl 和 workerSecret
# 设置后启动
node test-connect.js
```

插件会自动检测本地 Hanako 服务（通过 `server-info.json`），连接 Relay 后即可使用。

### 3. 浏览器访问

打开 Relay 的 URL，输入密码登录。

---

## 配置

### Relay 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 监听端口 | 3000 |
| `JWT_SECRET` | JWT 签名密钥（必填） | hana-remote-secret |
| `WORKER_SECRET` | 工作电脑认证密钥（必填） | - |
| `LOGIN_PASSWORD` | 登录密码 | hana-remote |
| `MAX_CLIENTS` | 最大客户端数 | 10 |
| `HEARTBEAT_TIMEOUT` | 心跳超时(ms) | 30000 |
| `RATE_LIMIT_WINDOW` | 限流窗口(ms) | 900000 (15min) |
| `RATE_LIMIT_MAX` | 限流窗口内最大尝试 | 5 |
| `SESSION_TIMEOUT_MINUTES` | Session 超时(min) | 30 |

### 插件配置

编辑 `test-connect.js`：

```javascript
plugin.start({
  relayUrl: 'wss://你的-render-域名.com',
  workerSecret: '你的密钥',
});
```

---

## 项目结构

```
hana-remote/
├── relay/                 # Render 中继服务
│   ├── index.js          # 入口（HTTP + WSS）
│   ├── config.js         # 配置
│   ├── auth.js           # JWT 认证 + 登录 + 限流
│   ├── conn-manager.js   # 连接管理（worker/client 配对）
│   ├── router.js         # 消息路由
│   ├── keepalive.js      # 心跳保活
│   └── public/           # 前端静态文件
│       ├── app.html      # 主页面
│       ├── login.html    # 登录页
│       ├── manifest.json # PWA 清单
│       ├── icons/        # 应用图标
│       ├── css/          # 样式
│       └── js/           # 前端逻辑
├── plugin/                # 工作电脑插件
│   ├── index.js          # 插件入口
│   ├── ws-client.js      # WebSocket 客户端
│   ├── hanako-api.js     # Hanako 对话引擎接口
│   ├── test-connect.js   # 启动脚本
│   └── handlers/         # 消息处理器
│       ├── chat.js       # 聊天
│       ├── files.js      # 文件操作
│       └── clipboard.js  # 剪贴板
├── 方案设计.md            # 技术方案文档
└── 开发计划.md            # 开发进度追踪
```

---

## 协议

消息使用 JSON 通过 WebSocket 传输。格式：

```json
// 客户端 → 中继 → 插件
{ "id": "msg_xxx", "type": "file_read", "payload": { "path": "C:/..." } }

// 插件 → 中继 → 客户端
{ "id": "msg_xxx", "ok": true, "type": "file_read", "payload": { "content": "..." } }
```

消息类型：`auth`, `file_tree`, `file_read`, `file_write`, `file_stat`, `file_search`, `chat`, `clipboard_set`, `clipboard_get`, `worker_connected`, `worker_disconnected`。
