# hana-remote

通过浏览器远程使用 Hanako 的工作能力。单人多设备，工作电脑常开，浏览器随时随地连接。

## 架构

浏览器 → Render 中继 ←outbound WSS← 工作电脑 Hanako 插件

## 模块

- `relay/` — Render 中继服务（WebSocket 配对 + 认证 + 托管前端）
- `plugin/` — Hanako 插件（连 Relay + 聊天注入 + 文件操作）
- `web/` — 前端页面（登录 + 文件树 + 聊天 + Monaco 编辑器）

## 快速开始

见 `方案设计.md`
