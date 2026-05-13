// relay/router.js — 消息路由
// 将浏览器的请求转发给 worker（Hanako 插件），并将回复回传给对应浏览器

// 写入操作日志（环形缓冲区）
const MAX_LOG_ENTRIES = 500;
const writeLog = [];

function addLogEntry(type, clientId, path, result) {
  writeLog.unshift({
    time: new Date().toISOString(),
    type,
    clientId,
    path,
    result,
  });
  if (writeLog.length > MAX_LOG_ENTRIES) writeLog.length = MAX_LOG_ENTRIES;
}

/**
 * 获取日志列表
 */
function getLogs(limit = 100) {
  return writeLog.slice(0, limit);
}

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

  // 记录写操作
  if (type === 'file_write') {
    addLogEntry('file_write', clientId, payload?.path || '?', 'pending');
  }

  // 检查 worker 是否在线
  if (!connManager.isOnline) {
    addLogEntry(type, clientId, payload?.path || '', 'failed: worker offline');
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
  // 保留 worker 返回的 ok 状态，默认为 true
  const ok = message.ok !== false;

  if (push) {
    // 推送消息 → 广播给所有 client
    connManager.broadcast(type, payload);
    return;
  }

  // 查找对应 client
  // 对于流式回复（chat 未完成），不删除 pending 记录
  const isStreaming = type === 'chat' && payload && !payload.done;
  const pending = isStreaming ? connManager.peekPending(id) : connManager.getPending(id);
  if (!pending) {
    return; // 没有等待这个回复的 client
  }

  // 流式回复完成时清理 pending
  if (type === 'chat' && payload && payload.done) {
    connManager.removePending(id);
  }

  // 写操作完成时更新日志
  if (pending.type === 'file_write') {
    addLogEntry('file_write', pending.clientId, payload?.path || '?', ok && payload?.ok ? 'ok' : 'failed');
  }

  const clientWs = connManager.clients.get(pending.clientId);
  if (!clientWs || clientWs.readyState !== 1) {
    return; // client 已断开
  }

  clientWs.send(JSON.stringify({ id, ok, type, payload }));
}

function sendError(ws, id, error) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify({ id, ok: false, error }));
  }
}

module.exports = { handleClientMessage, handleWorkerMessage };
