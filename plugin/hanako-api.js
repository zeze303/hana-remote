// plugin/hanako-api.js — Hanako 本地 API 客户端
// 通过 WebSocket 连接本地 Hanako 服务器，发送消息并流式接收回复

const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const http = require('http');

const HANA_DATA_DIR = path.join(process.env.USERPROFILE || 'C:/Users/default', '.hanako');

class HanakoApi {
  constructor() {
    this.serverInfo = null;
    this.sessionId = null;
    this.ws = null;
    this.ready = false;
  }

  /** 加载 server-info.json */
  _loadServerInfo() {
    const infoPath = path.join(HANA_DATA_DIR, 'server-info.json');
    try {
      const raw = fs.readFileSync(infoPath, 'utf-8');
      this.serverInfo = JSON.parse(raw);
      console.log(`[hanako-api] 服务器: 127.0.0.1:${this.serverInfo.port}`);
      return true;
    } catch (e) {
      console.error(`[hanako-api] 无法读取服务器信息: ${e.message}`);
      return false;
    }
  }

  /** HTTP 请求辅助 */
  _request(method, apiPath, body) {
    return new Promise((resolve, reject) => {
      if (!this.serverInfo) return reject(new Error('服务器信息未加载'));
      const options = {
        hostname: '127.0.0.1', port: this.serverInfo.port,
        path: apiPath, method,
        headers: { 'Authorization': `Bearer ${this.serverInfo.token}`, 'Content-Type': 'application/json' },
      };
      const req = http.request(options, res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, body: data }); }
        });
      });
      req.on('error', reject);
      req.setTimeout(5000, () => { req.destroy(); reject(new Error('请求超时')); });
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    });
  }

  /** 确保已创建会话 */
  async ensureSession() {
    if (this.sessionId) return this.sessionId;
    if (!this._loadServerInfo()) throw new Error('Hanako 未运行');

    // 优先使用已有会话
    try {
      const listRes = await this._request('GET', '/api/sessions');
      if (listRes.status === 200 && Array.isArray(listRes.body) && listRes.body.length > 0) {
        this.sessionId = listRes.body[0].path;
      }
    } catch {}

    if (!this.sessionId) {
      const res = await this._request('POST', '/api/sessions/new');
      if (res.status === 200 && res.body?.path) {
        this.sessionId = res.body.path;
      } else {
        throw new Error(`创建会话失败 (${JSON.stringify(res.body).slice(0, 100)})`);
      }
    }

    this.ready = true;
    console.log(`[hanako-api] 会话: ${this.sessionId}`);
    return this.sessionId;
  }

  /**
   * 发送消息到 Hanako，流式接收回复
   */
  async sendMessage(text, callbacks = {}) {
    const { onChunk, onDone, onError, onThinking, sessionPath } = callbacks;

    if (sessionPath) {
      // 使用指定的会话路径
      this.sessionId = sessionPath;
      this.ready = true;
    } else {
      try {
        await this.ensureSession();
      } catch (e) {
        if (onError) onError(e);
        return;
      }
    }

    this._wsSendMessage(text, onChunk, onDone, onError, onThinking);
  }

  _wsSendMessage(text, onChunk, onDone, onError, onThinking) {
    const wsUrl = `ws://127.0.0.1:${this.serverInfo.port}/ws?token=${this.serverInfo.token}`;

    try {
      const ws = new WebSocket(wsUrl);
      this.ws = ws;

      // 延迟完成定时器：收到 turn_end 后等多一会儿再关闭
      let graceTimer = null;
      let finalized = false;

      function clearGrace() {
        if (graceTimer) {
          clearTimeout(graceTimer);
          graceTimer = null;
        }
      }

      function finalize() {
        if (finalized) return;
        finalized = true;
        clearGrace();
        if (onDone) onDone();
        try { ws.close(); } catch {}
      }

      // 心跳保活：每 15 秒发 ping，防止 Hanako 服务端断开空闲连接
      let pingTimer = null;
      function startPing() {
        stopPing();
        pingTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.ping();
          } else {
            stopPing();
          }
        }, 15000);
      }
      function stopPing() {
        if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
      }

      ws.on('open', () => {
        startPing();
        ws.send(JSON.stringify({
          type: 'prompt',
          text,
          sessionPath: this.sessionId,
        }));
      });

      ws.on('pong', () => {
        // 收到 pong，连接正常
      });

      ws.on('message', raw => {
        try {
          const msg = JSON.parse(raw.toString());

          switch (msg.type) {
            case 'text_delta':
              // 收到新内容 → 取消延迟关闭，继续接收
              clearGrace();
              if (onChunk) onChunk(msg.delta || '');
              break;

            case 'thinking_delta':
              // 思考过程（内部推理、mood 等）
              clearGrace();
              if (onThinking) onThinking(msg.delta || '');
              break;

            case 'thinking_start':
              clearGrace();
              break;

            case 'thinking_end':
              clearGrace();
              break;

            case 'tool_start':
              clearGrace();
              // 工具调用开始
              if (onThinking) {
                const name = msg.name || '工具';
                const args = msg.args ? JSON.stringify(msg.args).slice(0, 200) : '';
                onThinking(`🔧 使用 ${name}${args ? ': ' + args : ''}`);
              }
              break;

            case 'tool_end':
              clearGrace();
              // 工具调用结束
              if (onThinking) {
                const status = msg.success ? '✅' : '❌';
                onThinking(`${status} ${msg.name || '工具'} 完成`);
              }
              break;

            case 'turn_end':
              // 不立即关闭，启动延迟定时器
              // 如果 Hanako 还在用工具或生成下一段，后续会有更多内容
              clearGrace();
              graceTimer = setTimeout(finalize, 180000);
              break;

            case 'error':
              clearGrace();
              if (onError) onError(new Error(msg.message || '未知错误'));
              ws.close();
              break;

            default:
              break;
          }
        } catch {}
      });

      ws.on('error', err => {
        clearGrace();
        console.log('[hanako-api] Hanako WS error:', err.message);
        if (onError) onError(err);
      });

      ws.on('close', (code, reason) => {
        clearGrace();
        stopPing();
        this.ws = null;
        console.log(`[hanako-api] Hanako WS closed: code=${code} reason=${reason || ''} finalized=${finalized}`);
        // 如果非正常结束（不是 finalize 触发的），通知前端
        if (!finalized) {
          finalized = true;
          if (onDone) onDone();
        }
      });

      // 超时保护（5 分钟，给工具执行留足时间）
      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          finalize();
        }
      }, 300000);

    } catch (e) {
      if (onError) onError(e);
    }
  }

  cancelMessage() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'abort', sessionPath: this.sessionId }));
    }
  }

  /**
   * 发送压缩会话命令（而不是 prompt 文本）
   * Hanako WS 协议接受 { type: "compact", sessionPath } 触发压缩
   */
  compactSession(sessionPath, callbacks = {}) {
    const { onDone, onError } = callbacks;
    if (!this.serverInfo) {
      if (onError) onError(new Error('Hanako 未初始化'));
      return;
    }

    this.sessionId = sessionPath;
    const wsUrl = `ws://127.0.0.1:${this.serverInfo.port}/ws?token=${this.serverInfo.token}`;

    try {
      const ws = new WebSocket(wsUrl);
      this.ws = ws;

      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'compact', sessionPath }));
      });

      ws.on('message', raw => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'error') {
            if (onError) onError(new Error(msg.message || '压缩失败'));
            ws.close();
          } else if (msg.type === 'turn_end') {
            if (onDone) onDone({ ok: true });
            ws.close();
          }
        } catch {}
      });

      ws.on('error', err => {
        if (onError) onError(err);
      });

      ws.on('close', () => { this.ws = null; });

      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close();
          if (onDone) onDone({ ok: true });
        }
      }, 30000);
    } catch (e) {
      if (onError) onError(e);
    }
  }
}

module.exports = { HanakoApi };
