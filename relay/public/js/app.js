// relay/public/js/app.js — 主页面逻辑（占位）

const token = localStorage.getItem('token');
if (!token) {
  window.location.href = '/';
}

// 显示登录用户信息
document.addEventListener('DOMContentLoaded', () => {
  const statusDot = document.getElementById('statusDot');
  const statusLabel = document.getElementById('statusLabel');

  // 尝试连接 WebSocket
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${location.host}/ws`;

  const ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    ws.send(JSON.stringify({
      type: 'auth',
      role: 'client',
      token: token,
    }));
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'auth' && msg.ok) {
      statusDot.className = msg.payload.workerOnline ? 'dot green' : 'dot yellow';
      statusLabel.textContent = msg.payload.workerOnline ? '工作电脑在线' : '工作电脑未连接';
    }
    if (msg.type === 'worker_connected') {
      statusDot.className = 'dot green';
      statusLabel.textContent = '工作电脑在线';
    }
    if (msg.type === 'worker_disconnected') {
      statusDot.className = 'dot yellow';
      statusLabel.textContent = '工作电脑未连接';
    }
  };

  ws.onclose = () => {
    statusDot.className = 'dot red';
    statusLabel.textContent = '连接断开';
  };
});
