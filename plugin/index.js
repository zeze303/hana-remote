// plugin/index.js — Hanako 远程插件入口
// 连接 Relay 中继，注册文件操作、聊天、会话管理
// 会话直接复用 Hanako 桌面端的 .jsonl 文件，实现双向互通

const WsClient = require('./ws-client');
const { handleFileTree, handleFileRead, handleFileWrite, handleFileStat, handleFileSearch } = require('./handlers/files');
const { handleClipboardSet, handleClipboardGet } = require('./handlers/clipboard');
const { createChatHandler } = require('./handlers/chat');
const sessionManager = require('./handlers/session-manager');

class HanaRemotePlugin {
  constructor(hanakoApi) {
    this.hanakoApi = hanakoApi;
    this.wsClient = null;
    this.chatHandler = null;
    this.activeSessionPath = null;
    this._sessionInitPromise = null;
  }

  start(config) {
    const relayUrl = config.relayUrl || process.env.RELAY_URL || 'ws://localhost:3000';
    const workerSecret = config.workerSecret || process.env.WORKER_SECRET || '';

    console.log('[hana-remote] 启动插件...');

    this.wsClient = new WsClient({ relayUrl, workerSecret });

    // 聊天处理器（历史和会话直接从 Jsonl 读取）
    this.chatHandler = createChatHandler({
      sendToRelay: (msg) => this._sendToRelayWithRetry(msg),
      hanakoApi: this.hanakoApi,
    });

    this.wsClient.on('message', (msg) => {
      this._handleMessage(msg);
    });

    this.wsClient.on('connected', () => {
      console.log('[hana-remote] 已连接到 Relay');
      // 如果 Hanako 还没就绪，启动定时重试
      if (!this.hanakoApi.ready) {
        this._startHanakoRetry();
      }
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

  /** 确保会话已初始化 */
  _ensureSessionsReady() {
    if (!this._sessionInitPromise) {
      this._sessionInitPromise = (async () => {
        this._initSessionManager();
        const sessions = await sessionManager.listSessions();
        if (sessions.length > 0) {
          this.activeSessionPath = sessions[0].hanakoSessionPath;
        }
      })();
    }
    return this._sessionInitPromise;
  }

  stop() {
    this._stopHanakoRetry();
    if (this.wsClient) {
      this.wsClient.disconnect();
      this.wsClient = null;
    }
    console.log('[hana-remote] 插件已停止');
  }

  /** 定期检测 Hanako 是否可用，初始失败后自动重连 */
  _startHanakoRetry() {
    if (this._hanakoRetryTimer) return;
    this._hanakoRetryTimer = setInterval(async () => {
      if (this.hanakoApi.ready) {
        this._stopHanakoRetry();
        return;
      }
      try {
        // 只检测连接性，不创建会话
        if (!this.hanakoApi.serverInfo && !this.hanakoApi._loadServerInfo()) {
          return;
        }
        // 尝试请求会话列表来检测 Hanako 是否在线
        const http = require('http');
        const res = await new Promise((resolve, reject) => {
          const req = http.request({
            hostname: '127.0.0.1',
            port: this.hanakoApi.serverInfo.port,
            path: '/api/sessions',
            method: 'GET',
            headers: { 'Authorization': `Bearer ${this.hanakoApi.serverInfo.token}` },
          }, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => resolve(d)); });
          req.on('error', reject);
          req.setTimeout(3000, () => { req.destroy(); reject(new Error('timeout')); });
          req.end();
        });
        if (res) {
          // Hanako 恢复在线，标记 ready 以便后续 _ensureSessionsReady 创建会话
          this.hanakoApi.ready = true;
          console.log('[hana-remote] Hanako 已恢复连接');
          this._stopHanakoRetry();
          // 通知前端
          if (this.wsClient && this.wsClient.connected) {
            this.wsClient.send({ push: true, type: 'hanako_ready' });
            // 初始化会话
            this._ensureSessionsReady().catch(() => {});
          }
        }
      } catch {}
    }, 15000);
  }
  _stopHanakoRetry() {
    if (this._hanakoRetryTimer) {
      clearInterval(this._hanakoRetryTimer);
      this._hanakoRetryTimer = null;
    }
  }

  async _handleMessage(msg) {
    const { id, type, payload } = msg;

    if (!type) {
      this.wsClient.send({ id, ok: false, error: '缺少消息类型' });
      return;
    }

    switch (type) {

      // ── 会话管理 ──
      case 'chat_session_list':
        try {
          await this._ensureSessionsReady();
          const sessions = await sessionManager.listSessions();
          this.wsClient.send({
            id, ok: true, type,
            payload: { sessions, active: this.activeSessionPath ? getSessionId(sessions, this.activeSessionPath) : null },
          });
        } catch (err) {
          this.wsClient.send({ id, ok: false, error: err.message });
        }
        break;

      case 'chat_session_create':
        try {
          await this._ensureSessionsReady();
          // 创建新的 Hanako 会话
          const http = require('http');
          const hanakoApi = this.hanakoApi;
          const options = {
            hostname: '127.0.0.1', port: hanakoApi.serverInfo.port,
            path: '/api/sessions/new', method: 'POST',
            headers: { 'Authorization': `Bearer ${hanakoApi.serverInfo.token}`, 'Content-Type': 'application/json' },
          };
          const newSession = await new Promise((resolve, reject) => {
            const req = http.request(options, res => {
              let data = '';
              res.on('data', c => data += c);
              res.on('end', () => {
                try { resolve(JSON.parse(data)); } catch { reject(new Error('创建失败')); }
              });
            });
            req.on('error', reject);
            req.setTimeout(5000, () => { req.destroy(); reject(new Error('超时')); });
            req.end();
          });
          if (newSession?.path) {
            this.activeSessionPath = newSession.path;
          }
          const sessions = await sessionManager.listSessions();
          this.wsClient.send({
            id, ok: true, type,
            payload: { sessions, active: this.activeSessionPath ? getSessionId(sessions, this.activeSessionPath) : null },
          });
        } catch (err) {
          this.wsClient.send({ id, ok: false, error: err.message });
        }
        break;

      case 'chat_session_delete':
        try {
          await this._ensureSessionsReady();
          const sessions = await sessionManager.listSessions();
          const session = sessions.find(s => s.id === payload.sessionId);
          if (session) {
            try {
              const http = require('http');
              const api = this.hanakoApi;
              const encodedPath = encodeURIComponent(session.hanakoSessionPath);
              await new Promise((resolve, reject) => {
                const req = http.request({
                  hostname: '127.0.0.1', port: api.serverInfo.port,
                  path: `/api/sessions/${encodedPath}`, method: 'DELETE',
                  headers: { 'Authorization': `Bearer ${api.serverInfo.token}` },
                }, res => { res.on('data', () => {}); res.on('end', resolve); });
                req.on('error', reject);
                req.setTimeout(5000, () => { req.destroy(); reject(new Error('超时')); });
                req.end();
              });
            } catch {}
            // 如果删除了当前会话，切换到第一个
            if (this.activeSessionPath === session.hanakoSessionPath) {
              const remaining = sessions.filter(s => s.id !== payload.sessionId);
              this.activeSessionPath = remaining.length > 0 ? remaining[0].hanakoSessionPath : null;
            }
          }
          const remaining = await sessionManager.listSessions();
          this.wsClient.send({
            id, ok: true, type,
            payload: { sessions: remaining, active: this.activeSessionPath ? getSessionId(remaining, this.activeSessionPath) : null },
          });
        } catch (err) {
          this.wsClient.send({ id, ok: false, error: err.message });
        }
        break;

      case 'chat_session_switch':
        try {
          await this._ensureSessionsReady();
          const sessions = await sessionManager.listSessions();
          const session = sessions.find(s => s.id === payload.sessionId);
          if (!session) {
            this.wsClient.send({ id, ok: false, error: '会话不存在' });
            break;
          }
          this.activeSessionPath = session.hanakoSessionPath;
          const history = sessionManager.getHistory(session.hanakoSessionPath);
          this.wsClient.send({
            id, ok: true, type,
            payload: { session, sessions, active: session.id, entries: history },
          });
        } catch (err) {
          this.wsClient.send({ id, ok: false, error: err.message });
        }
        break;

      // ── 上下文统计 ──
      case 'session_stats':
        try {
          await this._ensureSessionsReady();
          if (!this.activeSessionPath) {
            this.wsClient.send({ id, ok: true, type, payload: { chars: 0, tokens: 0, msgs: 0 } });
            break;
          }
          const stats = getSessionStats(this.activeSessionPath);
          this.wsClient.send({ id, ok: true, type, payload: stats });
        } catch (err) {
          this.wsClient.send({ id, ok: true, type, payload: { chars: 0, tokens: 0, msgs: 0 } });
        }
        break;

      // ── 聊天 ──
      case 'chat':
        try {
          await this._ensureSessionsReady();
          if (!this.activeSessionPath) {
            console.log('[chat] 没有可用会话');
            this.wsClient.send({ id, ok: false, error: '没有可用会话' });
            break;
          }

          // 拦截 /compact 命令，使用 WS compact 协议
          const text = msg.payload?.text || '';
          if (text.trim() === '/compact') {
            console.log('[chat] 执行 /compact');
            this.hanakoApi.compactSession(this.activeSessionPath, {
              onDone: () => {
                // 通知前端
                this.wsClient.send({ id, ok: true, type: 'chat', payload: { text: '✅ 对话已压缩', done: false } });
                this.wsClient.send({ id, ok: true, type: 'chat', payload: { text: '', done: true } });
                // 刷新会话列表缓存
                try { require('./handlers/session-manager').invalidateCache(); } catch {}
              },
              onError: (err) => {
                this.wsClient.send({ id, ok: false, type: 'chat', payload: { error: `压缩失败: ${err.message}` } });
              },
            });
            break;
          }

          console.log(`[chat] 发送消息到会话: ${this.activeSessionPath.slice(0, 60)}...`);
          const enhancedPayload = { ...msg.payload, sessionPath: this.activeSessionPath };
          this.chatHandler.handle({ ...msg, payload: enhancedPayload });
        } catch (err) {
          console.error('[chat] 发送失败:', err.message);
          this.wsClient.send({ id, ok: false, error: err.message });
        }
        break;

      case 'chat_cancel':
        this.chatHandler.cancel();
        break;

      // 聊天历史（从 .jsonl 直接读取）
      case 'chat_history':
        try {
          await this._ensureSessionsReady();
          if (!this.activeSessionPath) {
            this.wsClient.send({ id, ok: true, type, payload: { entries: [] } });
            break;
          }
          const entries = sessionManager.getHistory(this.activeSessionPath);
          this.wsClient.send({ id, ok: true, type, payload: { entries } });
        } catch (err) {
          this.wsClient.send({ id, ok: false, error: err.message });
        }
        break;

      case 'chat_history_clear':
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

  /**
   * 发送消息到 Relay，失败时自动重试（最多 20 次，间隔 2 秒）
   */
  _sendToRelayWithRetry(msg, retries = 20) {
    if (this.wsClient.send(msg)) return true;
    console.log(`[_sendToRelayWithRetry] 发送失败，剩余重试 ${retries} 次，msgType=${msg.type}`);
    if (retries <= 0) {
      console.log('[sendToRelayWithRetry] 重试耗尽，放弃发送');
      return false;
    }
    setTimeout(() => this._sendToRelayWithRetry(msg, retries - 1), 2000);
    return false;
  }
}

/** 根据 sessionPath 查找 session ID */
function getSessionId(sessions, sessionPath) {
  const s = sessions.find(s => s.hanakoSessionPath === sessionPath);
  return s ? s.id : null;
}

/**
 * 估算会话的 token 用量
 * 读取 .jsonl 文件，按中英文比例粗略估算
 */
function getSessionStats(sessionPath) {
  try {
    const fs = require('fs');
    const content = fs.readFileSync(sessionPath, 'utf-8');
    const lines = content.trim().split('\n');
    let chineseChars = 0, asciiChars = 0, msgCount = 0;
    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        if (msg.type !== 'message' || !msg.message) continue;
        if (msg.message.role !== 'user' && msg.message.role !== 'assistant') continue;
        const text = extractTextFromContent(msg.message.content);
        if (!text) continue;
        msgCount++;
        for (const ch of text) {
          if (ch > '\x7f') chineseChars++;
          else asciiChars++;
        }
      } catch {}
    }
    const totalBytes = Buffer.byteLength(content, 'utf-8');
    const estimatedTokens = Math.round(chineseChars * 1.5 + asciiChars * 0.25);
    return { chars: totalBytes, tokens: estimatedTokens, msgs: msgCount };
  } catch {
    return { chars: 0, tokens: 0, msgs: 0 };
  }
}

function extractTextFromContent(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    for (const c of content) {
      if (c.type === 'text' && c.text) return c.text;
    }
  }
  return '';
}

module.exports = HanaRemotePlugin;
