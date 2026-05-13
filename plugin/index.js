// plugin/index.js — Hanako 远程插件入口
// 连接 Relay 中继，注册文件操作和聊天消息处理

const WsClient = require('./ws-client');
const { handleFileTree, handleFileRead, handleFileWrite, handleFileStat, handleFileSearch } = require('./handlers/files');
const { handleClipboardSet, handleClipboardGet } = require('./handlers/clipboard');
const { createChatHandler } = require('./handlers/chat');
const chatHistory = require('./handlers/chat-history');

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

    // 聊天历史缓冲
    let chatResponseBuffer = [];

    // 创建聊天处理器（包装 sendToRelay 以记录历史）
    this.chatHandler = createChatHandler({
      sendToRelay: (msg) => {
        // 缓冲 Hanako 回复文本
        if (msg.type === 'chat' && msg.ok && msg.payload?.text && !msg.payload?.done) {
          chatResponseBuffer.push(msg.payload.text);
        }
        // 回复完成时保存到历史
        if (msg.type === 'chat' && msg.ok && msg.payload?.done) {
          const fullText = chatResponseBuffer.join('');
          if (fullText) chatHistory.addEntry('hanako', fullText);
          chatResponseBuffer = [];
        }
        this.wsClient.send(msg);
      },
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
        // 保存用户消息到历史
        if (msg.payload?.text) {
          chatHistory.addEntry('user', msg.payload.text);
        }
        this.chatHandler.handle(msg);
        break;

      // 取消聊天
      case 'chat_cancel':
        this.chatHandler.cancel();
        break;

      // 获取聊天历史
      case 'chat_history':
        this.wsClient.send({ id, ok: true, type, payload: { entries: chatHistory.loadHistory() } });
        break;

      // 清空聊天历史
      case 'chat_history_clear':
        chatHistory.clearHistory();
        this.wsClient.send({ id, ok: true, type, payload: { ok: true } });
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
