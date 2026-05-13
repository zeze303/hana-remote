// relay/router.js — 消息路由
// 将浏览器的请求转发给 worker（Hanako 插件），并将回复回传给对应浏览器

/**
 * 处理 client 发来的消息
 * @param {object} message - 解析后的 JSON 对象 { id, type, payload }
 * @param {string} clientId
 * @param {import('./conn-manager')} connManager
 * @param {import('ws').WebSocket} ws - client 的 WebSocket
 */
function handleClientMessage(message, clientId, connManager) {
  const { id, type, payload } = message;

  if (!id || !type) {
    sendError(ws, id, '消息格式错误：缺少 id 或 type');
    return;
  }

  // 检查 worker 是否在线
  if (!connManager.isOnline) {
    sendError(ws, id, '工作电脑未连接');
    return;
  }

  // 注册 pending 消息，等待 worker 回复
  connManager.registerPending(id, clientId, type);

  // 转发给 worker
  connManager.worker.send(JSON.stringify({ id, type, payload }));
}

/**
 * 处理 worker 发来的消息（回复或推送）
 */
function handleWorkerMessage(message, connManager) {
  const { id, type, payload, push } = message;

  if (push) {
    // 推送消息 → 广播给所有 client
    connManager.broadcast(type, payload);
    return;
  }

  // 查找对应 client
  const pending = connManager.getPending(id);
  if (!pending) {
    // 没有等待这个回复的 client，忽略
    return;
  }

  const clientWs = connManager.clients.get(pending.clientId);
  if (!clientWs || clientWs.readyState !== 1) {
    return; // client 已断开
  }

  clientWs.send(JSON.stringify({ id, ok: true, type, payload }));
}

function sendError(ws, id, error) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify({ id, ok: false, error }));
  }
}

module.exports = { handleClientMessage, handleWorkerMessage };
