// relay/index.js — 中继服务入口
// HTTP + WSS 服务器：登录 API + WebSocket 配对 + 静态文件托管

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const config = require('./config');
const auth = require('./auth');
const ConnectionManager = require('./conn-manager');
const { startHeartbeat, attachPongHandler } = require('./keepalive');
const { handleClientMessage, handleWorkerMessage } = require('./router');

const connManager = new ConnectionManager();
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// ── HTTP 服务器 ──
const server = http.createServer((req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');

  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // POST /login
  if (req.method === 'POST' && pathname === '/login') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { password } = JSON.parse(body);
        const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
        const result = auth.login(password, clientIp);
        res.writeHead(result.ok ? 200 : 401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '请求格式错误' }));
      }
    });
    return;
  }

  // GET /status — 连接状态（浏览器轮询用）
  if (req.method === 'GET' && pathname === '/status') {
    const data = {
      workerOnline: connManager.isOnline,
      clientCount: connManager.clients.size,
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
    return;
  }

  // GET /api/logs — 写入操作日志（需 JWT 验证）
  if (req.method === 'GET' && pathname === '/api/logs') {
    const token = req.headers['authorization']?.replace('Bearer ', '');
    if (!token || !auth.verifyToken(token)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: '未授权' }));
      return;
    }
    const { getLogs } = require('./router');
    const limit = parseInt(url.searchParams.get('limit')) || 100;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, logs: getLogs(limit) }));
    return;
  }

  // 静态文件
  // 路由到具体页面
  let serveFile;
  if (pathname === '/' || pathname === '/login') {
    serveFile = 'login.html';
  } else if (pathname === '/app') {
    serveFile = 'app.html';
  } else {
    serveFile = pathname;
  }

  let filePath = path.join(__dirname, config.staticDir, serveFile);
  const ext = path.extname(filePath);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // fallback 到 app.html（SPA 路由用）
      const fallback = path.join(__dirname, config.staticDir, 'app.html');
      fs.readFile(fallback, (err2, data2) => {
        if (err2) {
          res.writeHead(404);
          res.end('Not Found');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(data2);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

// ── WebSocket 服务器 ──
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  attachPongHandler(ws);

  // 等待第一条消息进行认证
  let authenticated = false;
  let role = null; // 'worker' | 'client'
  let clientId = null;

  const authTimer = setTimeout(() => {
    if (!authenticated) {
      ws.close(4001, '认证超时');
    }
  }, 10000);

  ws.on('message', raw => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      ws.send(JSON.stringify({ ok: false, error: '消息格式错误，需为 JSON' }));
      return;
    }

    // ── 认证消息 ──
    if (msg.type === 'auth') {
      clearTimeout(authTimer);

      if (msg.role === 'worker') {
        // Worker 认证：验证 secret
        if (!auth.verifyWorker(msg.secret)) {
          ws.close(4002, 'Worker secret 无效');
          return;
        }
        role = 'worker';
        authenticated = true;
        connManager.setWorker(ws);
        ws.send(JSON.stringify({ ok: true, type: 'auth', payload: { role: 'worker' } }));
        connManager.broadcast('worker_connected', { connected: true });
        return;
      }

      if (msg.role === 'client') {
        // Client 认证：验证 JWT
        const decoded = auth.verifyToken(msg.token);
        if (!decoded) {
          ws.close(4003, 'Token 无效或已过期');
          return;
        }
        role = 'client';
        authenticated = true;
        clientId = `client_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        connManager.addClient(clientId, ws);
        ws.send(JSON.stringify({
          ok: true, type: 'auth',
          payload: { clientId, workerOnline: connManager.isOnline }
        }));
        return;
      }

      ws.close(4004, '未知的角色类型');
      return;
    }

    // ── 未认证不处理业务消息 ──
    if (!authenticated) {
      ws.close(4005, '未认证');
      return;
    }

    // ── 业务消息 ──
    if (role === 'worker') {
      handleWorkerMessage(msg, connManager);
    } else if (role === 'client') {
      handleClientMessage(msg, clientId, connManager, ws);
    }
  });

  ws.on('close', () => {
    if (role === 'worker') {
      connManager.removeWorker();
      connManager.broadcast('worker_disconnected', { connected: false });
    } else if (role === 'client' && clientId) {
      connManager.removeClient(clientId);
    }
  });

  ws.on('error', () => {
    // 忽略连接错误，close 事件会处理清理
  });
});

// ── 启动 ──
const stopHeartbeat = startHeartbeat(connManager);

server.listen(config.port, () => {
  console.log(`[relay] 服务已启动: http://0.0.0.0:${config.port}`);
  console.log(`[relay] 工作电脑密钥: ${config.workerSecret}`);
  console.log(`[relay] JWT 密钥: ${config.jwtSecret}`);
});

// 优雅关闭
process.on('SIGTERM', () => {
  console.log('[relay] 收到 SIGTERM，正在关闭...');
  stopHeartbeat();
  wss.close();
  server.close();
  process.exit(0);
});
