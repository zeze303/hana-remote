// relay/keepalive.js — 心跳保活
// 定期 ping 所有连接，超时断开 stale 连接
const config = require('./config');

/**
 * 启动心跳检测
 * @param {import('./conn-manager')} connManager
 */
function startHeartbeat(connManager) {
  const timer = setInterval(() => {
    const now = Date.now();

    // Worker 心跳
    if (connManager.worker) {
      if (connManager.worker._lastPong && now - connManager.worker._lastPong > config.heartbeatTimeout) {
        connManager.worker.terminate();
        connManager.removeWorker();
        return;
      }
      if (connManager.worker.readyState === 1) {
        connManager.worker.ping();
      }
    }

    // Client 心跳
    for (const [clientId, ws] of connManager.clients) {
      if (ws.readyState !== 1) {
        connManager.removeClient(clientId);
        continue;
      }
      if (ws._lastPong && now - ws._lastPong > config.heartbeatTimeout) {
        ws.terminate();
        connManager.removeClient(clientId);
        continue;
      }
      ws.ping();
    }
  }, config.heartbeatInterval);

  // 清理
  return () => clearInterval(timer);
}

/**
 * 在 WebSocket 上绑定 pong 监听
 */
function attachPongHandler(ws) {
  ws._lastPong = Date.now();
  ws.on('pong', () => {
    ws._lastPong = Date.now();
  });
}

module.exports = { startHeartbeat, attachPongHandler };
