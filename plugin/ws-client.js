// plugin/ws-client.js — WSS 客户端
// 连接 Relay 中继，自动重连，收发消息，派发给对应 handler

const WebSocket = require('ws');
const EventEmitter = require('events');

class WsClient extends EventEmitter {
  constructor(config = {}) {
    super();
    this.relayUrl = config.relayUrl || process.env.RELAY_URL || 'ws://localhost:3000';
    this.secret = config.workerSecret || process.env.WORKER_SECRET || '';
    this.reconnectDelay = config.reconnectDelay || 5000;
    this.ws = null;
    this.connected = false;
    this._shouldReconnect = true;
    this._reconnectTimer = null;
  }

  /** 启动连接 */
  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    console.log(`[ws-client] 正在连接 ${this.relayUrl}...`);
    this.ws = new WebSocket(this.relayUrl);

    this.ws.on('open', () => {
      // 发送认证
      const authMsg = JSON.stringify({
        type: 'auth',
        role: 'worker',
        secret: this.secret,
      });
      this.ws.send(authMsg);
    });

    this.ws.on('message', raw => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        console.error('[ws-client] 收到非 JSON 消息:', raw.toString().slice(0, 200));
        return;
      }

      // 认证成功
      if (msg.type === 'auth' && msg.ok) {
        this.connected = true;
        console.log('[ws-client] 认证成功，已连接到 Relay');
        this.emit('connected');
        return;
      }

      // 认证失败
      if (msg.type === 'auth' && !msg.ok) {
        console.error('[ws-client] 认证失败:', msg.error);
        this.emit('error', new Error(msg.error));
        return;
      }

      // 业务消息 → 派发
      this.emit('message', msg);
    });

    this.ws.on('close', (code, reason) => {
      this.connected = false;
      console.log(`[ws-client] 连接断开 (${code}): ${reason || '无原因'} 重连=${this._shouldReconnect}`);
      this.emit('disconnected');
      this._scheduleReconnect();
    });

    this.ws.on('error', err => {
      console.error('[ws-client] 连接错误:', err.message);
      // close 事件会随后触发
    });
  }

  /** 断开连接 */
  disconnect() {
    this._shouldReconnect = false;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close(1000, 'client disconnect');
      this.ws = null;
    }
    this.connected = false;
  }

  /** 发送消息到 Relay */
  send(message) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
      return true;
    }
    return false;
  }

  /** 安排重连 */
  _scheduleReconnect() {
    if (!this._shouldReconnect) return;
    if (this._reconnectTimer) return;

    console.log(`[ws-client] ${this.reconnectDelay / 1000}s 后重连...`);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);
  }
}

module.exports = WsClient;
