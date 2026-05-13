// plugin/index.js — Hanako 远程插件入口
// 连接 Relay 中继，注册文件操作和聊天消息处理

const WsClient = require('./ws-client');
const { handleFileTree, handleFileRead, handleFileWrite, handleFileStat, handleFileSearch } = require('./handlers/files');
const { handleClipboardSet, handleClipboardGet } = require('./handlers/clipboard');
const { createChatHandler } = require('./handlers/chat');

class HanaRemotePlugin {
  constructor(hanakoApi) {
    this.hanakoApi = hanakoApi;     // Hanako 对话引擎接口
    this.wsClient = null;
    this.chatHandler = null;
  }

  // 启动
  start(config) {
    const relayUrl = config.relayUrl || process.env.RELAY_URL || 'ws://localhost:3000';
    const workerSecret = config.workerSecret || process.env.WORKER_SECRET || '';

    console.log('[hana-remote] 启动插件...');

    // 创建 WebSocket 客户端
    this.wsClient = new WsClient({ relayUrl, workerSecret });

    // 创建聊天处理器
    this.chatHandler = createChatHandler({
      sendToRelay: (msg) => this.wsClient.send(msg),
      hanakoApi: this.hanakoApi,
    });

    // 监听消息
    this.wsClient.on('message', (msg) => {
      this._handleMessage(msg);
    });

    this.wsClient.on('connected', () => {
      console.log('[hana-remote] 已连接到 Relay');
    });

    this.wsClient.on('disconnected', () => {
      console.log('[hana-remote] 与 Relay 断开');
    });

    // 连接
    this.wsClient.connect();
  }

  // 停止
  stop() {
    if (this.wsClient) {
      this.wsClient.disconnect();
      this.wsClient = null;
    }
    console.log('[hana-remote] 插件已停止');
  }

  // 消息分发
  _handleMessage(msg) {
    const { id, type, payload } = msg;

    if (!type) {
      this.wsClient.send({ id, ok: false, error: '缺少消息类型' });
      return;
    }

    switch (type) {
      // 聊天
      case 'chat':
        this.chatHandler.handle(msg);
        break;

      // 取消聊天
      case 'chat_cancel':
        this.chatHandler.cancel();
        break;

      // 文件操作
      case 'file_tree':
        handleFileTree(payload)
          .then(result => this.wsClient.send({ id, ok: true, type, payload: result }))
          .catch(err => this.wsClient.send({ id, ok: false, error: err.message }));
        break;

      case 'file_read':
        handleFileRead(payload)
          .then(result => {
            if (result.error) {
              this.wsClient.send({ id, ok: false, type, payload: result });
            } else {
              this.wsClient.send({ id, ok: true, type, payload: result });
            }
          })
          .catch(err => this.wsClient.send({ id, ok: false, error: err.message }));
        break;

      case 'file_write':
        handleFileWrite(payload)
          .then(result => {
            if (result.error) {
              this.wsClient.send({ id, ok: false, type, payload: result });
            } else {
              this.wsClient.send({ id, ok: true, type, payload: result });
            }
          })
          .catch(err => this.wsClient.send({ id, ok: false, error: err.message }));
        break;

      case 'file_stat':
        handleFileStat(payload)
          .then(result => this.wsClient.send({ id, ok: true, type, payload: result }))
          .catch(err => this.wsClient.send({ id, ok: false, error: err.message }));
        break;

      case 'file_search':
        handleFileSearch(payload)
          .then(result => this.wsClient.send({ id, ok: true, type, payload: result }))
          .catch(err => this.wsClient.send({ id, ok: false, error: err.message }));
        break;

      // 剪贴板
      case 'clipboard_set':
        handleClipboardSet(payload)
          .then(result => {
            if (result.error) {
              this.wsClient.send({ id, ok: false, type, payload: result });
            } else {
              this.wsClient.send({ id, ok: true, type, payload: result });
            }
          })
          .catch(err => this.wsClient.send({ id, ok: false, error: err.message }));
        break;

      case 'clipboard_get':
        handleClipboardGet()
          .then(result => this.wsClient.send({ id, ok: true, type, payload: result }))
          .catch(err => this.wsClient.send({ id, ok: false, error: err.message }));
        break;

      default:
        this.wsClient.send({ id, ok: false, error: `未知消息类型: ${type}` });
    }
  }
}

// 导出（供 Hanako 插件系统加载）
module.exports = HanaRemotePlugin;
