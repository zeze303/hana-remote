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
    const { onChunk, onDone, onError, onThinking } = callbacks;

    try {
      await this.ensureSession();
    } catch (e) {
      if (onError) onError(e);
      return;
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

      function clearGrace() {
        if (graceTimer) {
          clearTimeout(graceTimer);
          graceTimer = null;
        }
      }

      function finalize() {
        clearGrace();
        if (onDone) onDone();
        try { ws.close(); } catch {}
      }

      ws.on('open', () => {
        ws.send(JSON.stringify({
          type: 'prompt',
          text,
          sessionPath: this.sessionId,
        }));
      });

      ws.on('message', raw => {
        try {
          const msg = JSON.parse(raw.toString());

          switch (msg.type) {
            case 'text_delta':
              // 收到新内容 → 取消延迟关闭，继续接收
              if (onChunk) onChunk(msg.delta || '');
              break;

            case 'thinking':
              // 思考过程（内部推理、mood 等）
              if (onThinking) onThinking(msg.delta || '');
              break;

            case 'turn_end':
              // 不立即关闭，启动延迟定时器
              // 如果 Hanako 还在用工具，后续会有更多 text_delta
              clearGrace();
              graceTimer = setTimeout(finalize, 2000);
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
        if (onError) onError(err);
      });

      ws.on('close', () => {
        clearGrace();
        this.ws = null;
      });

      // 超时保护（120 秒，给工具执行留足时间）
      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          finalize();
        }
      }, 120000);

    } catch (e) {
      if (onError) onError(e);
    }
  }

  cancelMessage() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'abort', sessionPath: this.sessionId }));
    }
  }
}

module.exports = { HanakoApi };
