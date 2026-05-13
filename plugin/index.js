// plugin/index.js — Hanako 远程插件入口
// 连接 Relay 中继，注册文件操作、聊天、会话管理

const WsClient = require('./ws-client');
const { handleFileTree, handleFileRead, handleFileWrite, handleFileStat, handleFileSearch } = require('./handlers/files');
const { handleClipboardSet, handleClipboardGet } = require('./handlers/clipboard');
const { createChatHandler } = require('./handlers/chat');
const chatHistory = require('./handlers/chat-history');
const sessionManager = require('./handlers/session-manager');

class HanaRemotePlugin {
  constructor(hanakoApi) {
    this.hanakoApi = hanakoApi;
    this.wsClient = null;
    this.chatHandler = null;
    this.activeSessionId = null;
    this._sessionInitPromise = null;
  }

  start(config) {
    const relayUrl = config.relayUrl || process.env.RELAY_URL || 'ws://localhost:3000';
    const workerSecret = config.workerSecret || process.env.WORKER_SECRET || '';

    console.log('[hana-remote] 启动插件...');

    this.wsClient = new WsClient({ relayUrl, workerSecret });

    let chatResponseBuffer = [];

    this.chatHandler = createChatHandler({
      sendToRelay: (msg) => {
        if (msg.type === 'chat' && msg.ok && msg.payload?.text && !msg.payload?.done) {
          chatResponseBuffer.push(msg.payload.text);
        }
        if (msg.type === 'chat' && msg.ok && msg.payload?.done) {
          const fullText = chatResponseBuffer.join('');
          if (fullText && this.activeSessionId) {
            chatHistory.addEntry('hanako', fullText, this.activeSessionId);
          }
          chatResponseBuffer = [];
        }
        this.wsClient.send(msg);
      },
      hanakoApi: this.hanakoApi,
    });

    this.wsClient.on('message', (msg) => {
      this._handleMessage(msg);
    });

    this.wsClient.on('connected', () => {
      console.log('[hana-remote] 已连接到 Relay');
    });

    this.wsClient.on('disconnected', () => {
      console.log('[hana-remote] 与 Relay 断开');
    });

    this.wsClient.connect();
  }

  _initSessionManager() {
    if (this.hanakoApi && this.hanakoApi.serverInfo) {
      sessionManager.init(this.hanakoApi.serverInfo);
      console.log('[session] 会话管理器已初始化');
    } else {
      console.error('[session] 无法获取 Hanako 服务器信息');
    }
  }

  /** 确保会话已初始化，返回 Promise */
  _ensureSessionsReady() {
    if (!this._sessionInitPromise) {
      this._sessionInitPromise = (async () => {
        this._initSessionManager();
        await this._ensureDefaultSession();
      })();
    }
    return this._sessionInitPromise;
  }

  async _ensureDefaultSession() {
    const sessions = sessionManager.listSessions();
    if (sessions.length === 0) {
      const session = await sessionManager.createSession();
      this.activeSessionId = session.id;
      chatHistory.setSession(session.id);
      console.log(`[session] 默认会话: ${session.id}`);
    } else {
      this.activeSessionId = sessions[0].id;
      chatHistory.setSession(sessions[0].id);
      console.log(`[session] 使用现有会话: ${this.activeSessionId}`);
    }
  }

  stop() {
    if (this.wsClient) {
      this.wsClient.disconnect();
      this.wsClient = null;
    }
    console.log('[hana-remote] 插件已停止');
  }

  async _handleMessage(msg) {
    const { id, type, payload } = msg;

    if (!type) {
      this.wsClient.send({ id, ok: false, error: '缺少消息类型' });
      return;
    }

    switch (type) {

      // ── 会话管理 ──
      // ── 会话管理 ──
      case 'chat_session_list':
        this._ensureSessionsReady();
        this.wsClient.send({
          id, ok: true, type,
          payload: { sessions: sessionManager.listSessions(), active: this.activeSessionId },
        });
        break;

      case 'chat_session_create':
        (async () => {
          try {
            await this._ensureSessionsReady();
            const session = await sessionManager.createSession();
            this.activeSessionId = session.id;
            chatHistory.setSession(session.id);
            this.wsClient.send({
              id, ok: true, type,
              payload: { session, sessions: sessionManager.listSessions(), active: session.id },
            });
          } catch (err) {
            this.wsClient.send({ id, ok: false, error: err.message });
          }
        })();
        break;

      case 'chat_session_delete':
        sessionManager.deleteSession(payload.sessionId)
          .then(sessions => {
            // 如果删除了当前会话，切换到第一个
            if (this.activeSessionId === payload.sessionId) {
              this.activeSessionId = sessions.length > 0 ? sessions[0].id : null;
              if (this.activeSessionId) chatHistory.setSession(this.activeSessionId);
            }
            this.wsClient.send({
              id, ok: true, type,
              payload: { sessions, active: this.activeSessionId },
            });
          })
          .catch(err => this.wsClient.send({ id, ok: false, error: err.message }));
        break;

      case 'chat_session_switch':
        {
          const sessions = sessionManager.listSessions();
          const session = sessions.find(s => s.id === payload.sessionId);
          if (!session) {
            this.wsClient.send({ id, ok: false, error: '会话不存在' });
            break;
          }
          this.activeSessionId = session.id;
          chatHistory.setSession(session.id);

          // 返回会话信息和对应的聊天历史
          const history = chatHistory.loadHistory(session.id);
          this.wsClient.send({
            id, ok: true, type,
            payload: { session, sessions, active: session.id, entries: history },
          });
        }
        break;

      // ── 聊天 ──
      case 'chat':
        {
          await this._ensureSessionsReady();
          const sessions = sessionManager.listSessions();
          let session = sessions.find(s => s.id === this.activeSessionId);
          if (!session && sessions.length > 0) {
            session = sessions[0];
            this.activeSessionId = session.id;
            chatHistory.setSession(session.id);
          }
          if (!session) {
            this.wsClient.send({ id, ok: false, error: '没有可用会话' });
            break;
          }

          // 保存用户消息到当前会话的历史
          if (msg.payload?.text) {
            chatHistory.addEntry('user', msg.payload.text, this.activeSessionId);
          }

          // 更新会话标题（基于首条消息）
          const msgs = chatHistory.loadHistory(this.activeSessionId);
          const userMsgCount = msgs.filter(e => e.type === 'user').length;
          if (userMsgCount === 1 && msg.payload?.text) {
            sessionManager.renameSession(this.activeSessionId, msg.payload.text.slice(0, 50));
          }

          // 用指定会话路径发消息
          const enhancedPayload = { ...msg.payload, sessionPath: session.hanakoSessionPath };
          this.chatHandler.handle({ ...msg, payload: enhancedPayload });
        }
        break;

      case 'chat_cancel':
        this.chatHandler.cancel();
        break;

      case 'chat_history':
        this.wsClient.send({
          id, ok: true, type,
          payload: { entries: chatHistory.loadHistory(this.activeSessionId) },
        });
        break;

      case 'chat_history_clear':
        chatHistory.clearHistory(this.activeSessionId);
        this.wsClient.send({ id, ok: true, type, payload: { ok: true } });
        break;

      // ── 文件操作 ──
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

      // ── 剪贴板 ──
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

module.exports = HanaRemotePlugin;
