// relay/conn-manager.js — 连接管理器
// 管理 worker（Hanako 插件）和 client（浏览器）连接，配对转发
const EventEmitter = require('events');

class ConnectionManager extends EventEmitter {
  constructor() {
    super();
    this.worker = null;       // 唯一的 worker WebSocket
    this.clients = new Map();  // clientId → WebSocket
    this.msgQueue = new Map(); // msgId → { clientId, type } 等待 worker 回复
  }

  /** Worker 连接 */
  setWorker(ws) {
    if (this.worker && this.worker.readyState === 1) {
      this.worker.close(1000, 'replaced by new worker');
    }
    this.worker = ws;
    this.emit('worker:online');
    return true;
  }

  /** Worker 断开 */
  removeWorker() {
    this.worker = null;
    // 清理所有等待 worker 回复的消息
    this.msgQueue.clear();
    this.emit('worker:offline');
  }

  /** Client 连接 */
  addClient(clientId, ws) {
    this.clients.set(clientId, ws);
    this.emit('client:connect', clientId);
  }

  /** Client 断开 */
  removeClient(clientId) {
    this.clients.delete(clientId);
    // 清理该 client 的待回复消息
    for (const [msgId, entry] of this.msgQueue) {
      if (entry.clientId === clientId) {
        this.msgQueue.delete(msgId);
      }
    }
    this.emit('client:disconnect', clientId);
  }

  /** 注册等待响应的消息 */
  registerPending(msgId, clientId, type) {
    this.msgQueue.set(msgId, { clientId, type, timestamp: Date.now() });
  }

  /** 取回 pending 记录（取后删除） */
  getPending(msgId) {
    const entry = this.msgQueue.get(msgId);
    if (entry) this.msgQueue.delete(msgId);
    return entry;
  }

  /** 查看 pending 记录（不删除，用于流式回复） */
  peekPending(msgId) {
    return this.msgQueue.get(msgId) || null;
  }

  /** 手动删除 pending 记录 */
  removePending(msgId) {
    this.msgQueue.delete(msgId);
  }

  /** 广播给所有 client */
  broadcast(type, payload) {
    const message = JSON.stringify({ push: true, type, payload });
    for (const [clientId, ws] of this.clients) {
      if (ws.readyState === 1) {
        ws.send(message);
      } else {
        this.removeClient(clientId);
      }
    }
  }

  /** 是否在线 */
  get isOnline() {
    return this.worker !== null && this.worker.readyState === 1;
  }
}

module.exports = ConnectionManager;
