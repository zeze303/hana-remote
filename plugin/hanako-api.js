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

    const res = await this._request('POST', '/api/sessions/new');
    if (res.status === 200 && res.body?.id) {
      this.sessionId = res.body.id;
      this.ready = true;
      console.log(`[hanako-api] 会话: ${this.sessionId}`);
      return this.sessionId;
    }
    throw new Error(`创建会话失败 (${res.status})`);
  }

  /**
   * 发送消息到 Hanako，流式接收回复
   */
  async sendMessage(text, callbacks = {}) {
    const { onChunk, onDone, onError } = callbacks;

    try {
      await this.ensureSession();
    } catch (e) {
      if (onError) onError(e);
      return;
    }

    // 通过 WebSocket 连接进行对话
    this._wsSendMessage(text, onChunk, onDone, onError);
  }

  _wsSendMessage(text, onChunk, onDone, onError) {
    const wsUrl = `ws://127.0.0.1:${this.serverInfo.port}/ws?token=${this.serverInfo.token}`;

    try {
      const ws = new WebSocket(wsUrl);

      ws.on('open', () => {
        // 发送对话消息
        ws.send(JSON.stringify({
          type: 'session:send',
          sessionId: this.sessionId,
          text,
        }));
      });

      ws.on('message', raw => {
        try {
          const msg = JSON.parse(raw.toString());

          if (msg.type === 'stream' && msg.text) {
            if (onChunk) onChunk(msg.text);
          }

          if (msg.type === 'done' || msg.done) {
            if (onDone) onDone();
            ws.close();
          }

          if (msg.error) {
            if (onError) onError(new Error(msg.error));
            ws.close();
          }
        } catch {}
      });

      ws.on('error', err => {
        if (onError) onError(err);
      });

      ws.on('close', () => {
        if (onDone) onDone();
      });

      // 超时保护
      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close();
          if (onDone) onDone();
        }
      }, 60000);

    } catch (e) {
      if (onError) onError(e);
    }
  }

  cancelMessage() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'cancel', sessionId: this.sessionId }));
    }
  }
}

module.exports = { HanakoApi };
