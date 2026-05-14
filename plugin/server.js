// plugin/server.js — 本地 HTTP + WebSocket 服务器
// 通过 Cloudflare Tunnel 暴露到公网，替代 Render 中继
// 浏览器 → Cloudflare → Tunnel → 本机服务器 → Hanako

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { HanakoApi } = require('./hanako-api');
const sessionManager = require('./handlers/session-manager');
const { createChatHandler } = require('./handlers/chat');
const {
  handleFileTree, handleFileRead, handleFileWrite, handleFileStat, handleFileSearch,
} = require('./handlers/files');
const { handleClipboardSet, handleClipboardGet } = require('./handlers/clipboard');

// ======================== 配置 ========================
const PORT = parseInt(process.env.LOCAL_PORT) || 3456;
const PASSWORD = process.env.LOGIN_PASSWORD || 'LEsUvWwUxIuLJYURYbK1D8j6';
const JWT_SECRET = process.env.JWT_SECRET || 'hana-remote-local-server-secret-2026';
const STATIC_DIR = path.join(__dirname, 'public');
const SESSION_TIMEOUT = 30 * 60 * 1000;

// ======================== JWT（纯 HMAC SHA256，无额外依赖） ========================
function base64url(data) {
  return Buffer.from(data).toString('base64url');
}

function fromBase64url(str) {
  return Buffer.from(str, 'base64url').toString('utf-8');
}

function signToken(payload) {
  const h = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const b = base64url(JSON.stringify({ ...payload, exp: Date.now() + SESSION_TIMEOUT }));
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(h + '.' + b).digest('base64url');
  return h + '.' + b + '.' + sig;
}

function verifyToken(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const expected = crypto.createHmac('sha256', JWT_SECRET).update(parts[0] + '.' + parts[1]).digest('base64url');
    if (parts[2] !== expected) return null;
    const payload = JSON.parse(fromBase64url(parts[1]));
    if (payload.exp && payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

// ======================== 登录限流 ========================
const failedAttempts = new Map();
const RATE_LIMIT_LOGIN = 5;
const RATE_LIMIT_WINDOW = 15 * 60 * 1000;

// ======================== 写操作日志 ========================
const writeLog = [];
const MAX_LOG = 500;
function logWrite(op, filePath, info) {
  writeLog.push({ ts: new Date().toISOString(), op, path: filePath, info });
  if (writeLog.length > MAX_LOG) writeLog.shift();
}

// ======================== MIME 类型 ========================
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

// ======================== 辅助 ========================
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('请求格式错误'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res) {
  let p = new URL(req.url, `http://${req.headers.host}`).pathname;
  if (p === '/' || p === '/login') p = '/login.html';
  else if (p === '/app') p = '/app.html';
  const filePath = path.join(STATIC_DIR, p);
  if (!filePath.startsWith(STATIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      const fb = path.join(STATIC_DIR, 'app.html');
      fs.readFile(fb, (e2, d2) => {
        if (e2) {
          res.writeHead(404);
          res.end('Not Found');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(d2);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

function getSessionId(sessions, sessionPath) {
  const s = sessions.find((s) => s.hanakoSessionPath === sessionPath);
  return s ? s.id : null;
}

function countMessages(sessionPath) {
  try {
    const fd = fs.openSync(sessionPath, 'r');
    const buf = Buffer.alloc(65536);
    const bytesRead = fs.readSync(fd, buf, 0, 65536, 0);
    fs.closeSync(fd);
    const partial = buf.toString('utf-8', 0, bytesRead);
    let count = 0;
    for (const line of partial.split('\n')) {
      try {
        const m = JSON.parse(line);
        if (m.type === 'message' && m.message?.role === 'user') count++;
      } catch {}
    }
    return count;
  } catch {
    return 0;
  }
}

function getContextUsage(hanakoApi, sessionPath) {
  return new Promise((resolve) => {
    try {
      const WebSocket = require('ws');
      const wsUrl = `ws://127.0.0.1:${hanakoApi.serverInfo.port}/ws?token=${hanakoApi.serverInfo.token}`;
      const ws = new WebSocket(wsUrl);
      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolve(null);
          ws.close();
        }
      }, 3000);
      ws.on('open', () => ws.send(JSON.stringify({ type: 'context_usage', sessionPath })));
      ws.on('message', (raw) => {
        try {
          const m = JSON.parse(raw.toString());
          if (m.type === 'context_usage' && m.sessionPath === sessionPath && !resolved) {
            resolved = true;
            clearTimeout(timeout);
            ws.close();
            resolve(m);
          }
        } catch {}
      });
      ws.on('error', () => {
        if (!resolved) {
          resolved = true;
          resolve(null);
        }
      });
      ws.on('close', () => {
        if (!resolved) {
          resolved = true;
          resolve(null);
        }
      });
    } catch {
      resolve(null);
    }
  });
}

// 代理 HTTP 请求到 Hanako 本地 API
function proxyToHanako(hanakoApi, method, apiPath, res, body) {
  const opts = {
    hostname: '127.0.0.1',
    port: hanakoApi.serverInfo.port,
    path: apiPath,
    method,
    headers: {
      Authorization: `Bearer ${hanakoApi.serverInfo.token}`,
      'Content-Type': 'application/json',
    },
  };
  const req = http.request(opts, (proxyRes) => {
    let data = '';
    proxyRes.on('data', (c) => (data += c));
    proxyRes.on('end', () => {
      try {
        res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' });
        res.end(data);
      } catch {}
    });
  });
  req.on('error', () => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Hanako 不可达' }));
  });
  if (body) req.write(JSON.stringify(body));
  req.end();
}

// ======================== HTTP 服务器 ========================
function createHttpServer(hanakoApi, activeSession) {
  return http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;

    // ── POST /login（不需要 JWT）──
    if (req.method === 'POST' && p === '/login') {
      readJsonBody(req)
        .then(({ password }) => {
          const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
          const now = Date.now();
          const rec = failedAttempts.get(ip);
          if (rec && now - rec.windowStart < RATE_LIMIT_WINDOW && rec.count >= RATE_LIMIT_LOGIN) {
            const retry = Math.ceil((RATE_LIMIT_WINDOW - (now - rec.windowStart)) / 1000);
            res.writeHead(429, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: `尝试次数过多，请在 ${retry} 秒后重试`, retryAfter: retry }));
            return;
          }
          if (rec && now - rec.windowStart >= RATE_LIMIT_WINDOW) failedAttempts.delete(ip);

          if (password !== PASSWORD) {
            const e = failedAttempts.get(ip) || { count: 0, windowStart: now };
            e.count++;
            if (!failedAttempts.has(ip)) e.windowStart = now;
            failedAttempts.set(ip, e);
            const left = RATE_LIMIT_LOGIN - e.count;
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: `密码错误，还剩 ${left} 次机会` }));
            return;
          }
          failedAttempts.delete(ip);
          const token = signToken({ role: 'client', clientId: `client_${now}` });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, token }));
        })
        .catch((err) => {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        });
      return;
    }

    // 以下路由需要 JWT
    const token = req.headers['authorization']?.replace('Bearer ', '') || '';
    const session = verifyToken(token);
    if (!session) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: '未授权' }));
      return;
    }

    // ── GET /status ──
    if (req.method === 'GET' && p === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        workerOnline: true,
        clientCount: 1,
        hanakoReady: hanakoApi?.ready || false,
      }));
      return;
    }

    // ── GET /api/logs ──
    if (req.method === 'GET' && p === '/api/logs') {
      const limit = parseInt(url.searchParams.get('limit')) || 100;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, logs: writeLog.slice(-limit) }));
      return;
    }

    // ── GET /api/sessions ──
    if (req.method === 'GET' && p === '/api/sessions') {
      sessionManager
        .listSessions()
        .then((sessions) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, sessions }));
        })
        .catch((err) => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        });
      return;
    }

    // ── POST /api/sessions/new ──
    if (req.method === 'POST' && p === '/api/sessions/new') {
      proxyToHanako(hanakoApi, 'POST', '/api/sessions/new', res);
      return;
    }

    // ── DELETE /api/sessions/:path ──
    const delMatch = p.match(/^\/api\/sessions\/(.+)$/);
    if (req.method === 'DELETE' && delMatch) {
      const hanakoPath = decodeURIComponent(delMatch[1]);
      proxyToHanako(hanakoApi, 'DELETE', `/api/sessions/${delMatch[1]}`, res);
      return;
    }

    // ── GET /api/sessions/:path/history ──
    const histMatch = p.match(/^\/api\/sessions\/(.+)\/history$/);
    if (req.method === 'GET' && histMatch) {
      const sessionPath = decodeURIComponent(histMatch[1]);
      const entries = sessionManager.getHistory(sessionPath);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, entries }));
      return;
    }

    // ── GET /api/files/* ──
    if (p.startsWith('/api/files/')) {
      const filePath = decodeURIComponent(p.slice('/api/files/'.length));

      // 文件读取: ?op=read&path=xxx
      if (req.method === 'GET' && url.searchParams.get('op') === 'read') {
        handleFileRead({ path: filePath })
          .then((result) => {
            const ok = !result.error;
            res.writeHead(ok ? 200 : 400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(ok ? { ok, ...result } : { ok, error: result.error }));
          })
          .catch((err) => {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: err.message }));
          });
        return;
      }

      // 文件信息: ?op=stat&path=xxx
      if (req.method === 'GET' && url.searchParams.get('op') === 'stat') {
        handleFileStat({ path: filePath })
          .then((result) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, ...result }));
          })
          .catch((err) => {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: err.message }));
          });
        return;
      }

      // 搜索: ?op=search&q=xxx
      if (req.method === 'GET' && url.searchParams.get('op') === 'search') {
        handleFileSearch({
          path: filePath,
          query: url.searchParams.get('q') || '',
        })
          .then((result) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, ...result }));
          })
          .catch((err) => {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: err.message }));
          });
        return;
      }

      // 默认：文件树
      handleFileTree({ path: filePath })
        .then((result) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        })
        .catch((err) => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        });
      return;
    }

    // ── POST /api/files/write ──
    if (req.method === 'POST' && p === '/api/files/write') {
      readJsonBody(req)
        .then((body) => {
          handleFileWrite(body)
            .then((result) => {
              if (!result.error) logWrite('write', body.path, `${body.content?.length || 0} chars`);
              res.writeHead(result.error ? 400 : 200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(result.error ? { ok: false, error: result.error } : { ok: true }));
            })
            .catch((err) => {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: err.message }));
            });
        })
        .catch((err) => {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        });
      return;
    }

    // ── POST /api/clipboard/set ──
    if (req.method === 'POST' && p === '/api/clipboard/set') {
      readJsonBody(req)
        .then((body) => {
          handleClipboardSet(body).then((result) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: !result.error, error: result.error }));
          });
        })
        .catch((err) => {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        });
      return;
    }

    // ── GET /api/clipboard/get ──
    if (req.method === 'GET' && p === '/api/clipboard/get') {
      handleClipboardGet()
        .then((result) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, text: result.text }));
        })
        .catch((err) => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        });
      return;
    }

    // ── 默认：静态文件 ──
    serveStatic(req, res);
  });
}

// ======================== WebSocket 服务器 ========================
function createWSServer(server, hanakoApi, activeSession) {
  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws, req) => {
    // 支持两种认证：URL query token 或消息体发送
    const urlToken = new URL(req.url, `http://${req.headers.host}`).searchParams.get('token');
    let authenticated = false;

    const authTimer = setTimeout(() => {
      if (!authenticated) ws.close(4001, '认证超时');
    }, 10000);

    // 如果 URL 带了 token，直接通过
    if (urlToken) {
      const s = verifyToken(urlToken);
      if (s) {
        clearTimeout(authTimer);
        authenticated = true;
      }
    }

    // 每个 WS 连接独立的 chatHandler（流式输出用 ws.send 回传）
    const chatHandler = createChatHandler({
      sendToRelay: (msg) => {
        try {
          ws.send(JSON.stringify(msg));
          return true;
        } catch {
          return false;
        }
      },
      hanakoApi,
    });

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      const { id, type, payload: msgPayload } = msg;

      // ── 认证消息 ──
      if (type === 'auth') {
        clearTimeout(authTimer);
        const decoded = verifyToken(msg.token || '');
        if (!decoded) {
          ws.close(4003, 'Token 无效或已过期');
          return;
        }
        authenticated = true;
        ws.send(
          JSON.stringify({
            ok: true,
            type: 'auth',
            payload: { clientId: decoded.clientId || `client_${Date.now()}`, workerOnline: true },
          })
        );
        // 主动推送会话列表
        sessionManager.listSessions().then((sessions) => {
          ws.send(
            JSON.stringify({
              type: 'chat_session_list',
              ok: true,
              payload: { sessions, active: getSessionId(sessions, activeSession.path) },
            })
          );
        }).catch(() => {});
        return;
      }

      if (!authenticated) {
        ws.close(4005, '未认证');
        return;
      }

      // ── 业务消息 ──
      const send = (payload) => ws.send(JSON.stringify(payload));

      switch (type) {
        case 'chat_session_list':
          sessionManager
            .listSessions()
            .then((sessions) => {
              send({ id, ok: true, type, payload: { sessions, active: getSessionId(sessions, activeSession.path) } });
            })
            .catch((err) => send({ id, ok: false, error: err.message }));
          break;

        case 'chat_session_create':
          (async () => {
            try {
              const result = await new Promise((resolve, reject) => {
                const r2 = http.request(
                  {
                    hostname: '127.0.0.1',
                    port: hanakoApi.serverInfo.port,
                    path: '/api/sessions/new',
                    method: 'POST',
                    headers: {
                      Authorization: `Bearer ${hanakoApi.serverInfo.token}`,
                      'Content-Type': 'application/json',
                    },
                  },
                  (res2) => {
                    let d = '';
                    res2.on('data', (c) => (d += c));
                    res2.on('end', () => {
                      try {
                        resolve(JSON.parse(d));
                      } catch {
                        reject();
                      }
                    });
                  }
                );
                r2.on('error', reject);
                r2.end();
              });
              if (result?.path) activeSession.path = result.path;
              const sessions = await sessionManager.listSessions(true);
              send({ id, ok: true, type, payload: { sessions, active: getSessionId(sessions, activeSession.path) } });
            } catch {
              send({ id, ok: false, error: '创建失败' });
            }
          })();
          break;

        case 'chat_session_delete':
          (async () => {
            try {
              const sessions = await sessionManager.listSessions();
              const session = sessions.find((s) => s.id === msgPayload.sessionId);
              if (session) {
                const enc = encodeURIComponent(session.hanakoSessionPath);
                await new Promise((resolve) => {
                  const r2 = http.request(
                    {
                      hostname: '127.0.0.1',
                      port: hanakoApi.serverInfo.port,
                      path: `/api/sessions/${enc}`,
                      method: 'DELETE',
                      headers: { Authorization: `Bearer ${hanakoApi.serverInfo.token}` },
                    },
                    (res2) => {
                      res2.on('data', () => {});
                      res2.on('end', resolve);
                    }
                  );
                  r2.on('error', resolve);
                  r2.end();
                });
                if (activeSession.path === session.hanakoSessionPath) {
                  const remaining = sessions.filter((s) => s.id !== msgPayload.sessionId);
                  activeSession.path = remaining.length > 0 ? remaining[0].hanakoSessionPath : null;
                }
              }
              const remaining = await sessionManager.listSessions(true);
              send({
                id,
                ok: true,
                type,
                payload: { sessions: remaining, active: getSessionId(remaining, activeSession.path) },
              });
            } catch (err) {
              send({ id, ok: false, error: err.message });
            }
          })();
          break;

        case 'chat_session_switch':
          (async () => {
            try {
              const sessions = await sessionManager.listSessions();
              const session = sessions.find((s) => s.id === msgPayload.sessionId);
              if (!session) {
                send({ id, ok: false, error: '会话不存在' });
                return;
              }
              activeSession.path = session.hanakoSessionPath;
              const history = sessionManager.getHistory(session.hanakoSessionPath);
              send({ id, ok: true, type, payload: { session, sessions, active: session.id, entries: history } });
            } catch (err) {
              send({ id, ok: false, error: err.message });
            }
          })();
          break;

        case 'session_stats':
          (async () => {
            try {
              if (!activeSession.path) {
                send({ id, ok: true, type, payload: { tokens: 0, msgs: 0 } });
                return;
              }
              const ctx = await getContextUsage(hanakoApi, activeSession.path);
              const msgs = countMessages(activeSession.path);
              send({ id, ok: true, type, payload: { tokens: ctx?.tokens ?? 0, msgs } });
            } catch {
              send({ id, ok: true, type, payload: { tokens: 0, msgs: 0 } });
            }
          })();
          break;

        case 'chat':
          (async () => {
            try {
              if (!activeSession.path) {
                send({ id, ok: false, error: '没有可用会话' });
                return;
              }
              const text = msgPayload?.text || '';
              if (text.trim() === '/compact') {
                hanakoApi.compactSession(activeSession.path, {
                  onDone: () => {
                    send({ id, ok: true, type: 'chat', payload: { text: '✅ 对话已压缩', done: false } });
                    send({ id, ok: true, type: 'chat', payload: { text: '', done: true } });
                    try { sessionManager.invalidateCache(); } catch {}
                  },
                  onError: (err) => {
                    send({ id, ok: false, type: 'chat', payload: { error: `压缩失败: ${err.message}` } });
                  },
                });
                return;
              }
              chatHandler.handle({ id, type: 'chat', payload: { ...msgPayload, sessionPath: activeSession.path } });
            } catch (err) {
              send({ id, ok: false, error: err.message });
            }
          })();
          break;

        case 'chat_cancel':
          chatHandler.cancel();
          break;

        case 'chat_history':
          (async () => {
            try {
              if (!activeSession.path) {
                send({ id, ok: true, type, payload: { entries: [] } });
                return;
              }
              const entries = sessionManager.getHistory(activeSession.path);
              send({ id, ok: true, type, payload: { entries } });
            } catch (err) {
              send({ id, ok: false, error: err.message });
            }
          })();
          break;

        case 'file_tree':
          handleFileTree(msgPayload)
            .then((r) => send({ id, ok: true, type, payload: r }))
            .catch((err) => send({ id, ok: false, error: err.message }));
          break;

        case 'file_read':
          handleFileRead(msgPayload)
            .then((r) => send({ id, ok: !r.error, type, payload: r }))
            .catch((err) => send({ id, ok: false, error: err.message }));
          break;

        case 'file_write':
          handleFileWrite(msgPayload)
            .then((r) => {
              if (!r.error) logWrite('write', msgPayload.path, `${msgPayload.content?.length || 0} chars`);
              send({ id, ok: !r.error, type, payload: r });
            })
            .catch((err) => send({ id, ok: false, error: err.message }));
          break;

        case 'file_stat':
          handleFileStat(msgPayload)
            .then((r) => send({ id, ok: true, type, payload: r }))
            .catch((err) => send({ id, ok: false, error: err.message }));
          break;

        case 'file_search':
          handleFileSearch(msgPayload)
            .then((r) => send({ id, ok: true, type, payload: r }))
            .catch((err) => send({ id, ok: false, error: err.message }));
          break;

        case 'clipboard_set':
          handleClipboardSet(msgPayload)
            .then((r) => send({ id, ok: !r.error, type, payload: r }));
          break;

        case 'clipboard_get':
          handleClipboardGet()
            .then((r) => send({ id, ok: true, type, payload: r }));
          break;

        default:
          send({ id, ok: false, error: `未知消息类型: ${type}` });
      }
    });

    ws.on('close', () => {
      chatHandler.cancel();
    });
  });

  return wss;
}

// ======================== 启动入口 ========================
async function main() {
  console.log('[server] 启动本地服务器...');

  // 连接 Hanako
  const hanakoApi = new HanakoApi();
  let hanakoReady = false;
  try {
    await hanakoApi.ensureSession();
    hanakoReady = true;
    console.log('[server] 已连接到 Hanako');
  } catch (e) {
    console.log('[server] 未检测到 Hanako:', e.message);
    console.log('[server] 聊天功能将不可用，文件浏览/编辑不受影响');
  }

  // 初始化会话管理器
  if (hanakoApi.serverInfo) {
    sessionManager.init(hanakoApi.serverInfo);
  }
  const sessions = await sessionManager.listSessions().catch(() => []);
  const activeSession = { path: sessions.length > 0 ? sessions[0].hanakoSessionPath : null };

  // 创建 HTTP + WS 服务器
  const httpServer = createHttpServer(hanakoApi, activeSession);
  createWSServer(httpServer, hanakoApi, activeSession);

  httpServer.listen(PORT, '127.0.0.1', () => {
    console.log(`[server] 本地服务器已启动: http://127.0.0.1:${PORT}`);
    console.log(`[server] 登录密码: ${PASSWORD.slice(0, 3)}...${PASSWORD.slice(-3)}`);
    console.log('[server] 通过 Cloudflare Tunnel 暴露到公网即可');
  });

  // 定期刷新会话缓存
  setInterval(() => {
    if (activeSession.path) sessionManager.invalidateCache();
  }, 30000);

  // 错误处理
  process.on('uncaughtException', (err) => {
    console.error('[server] 未捕获异常:', err.message, err.stack?.slice(0, 300));
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[server] 未捕获拒绝:', reason?.message || reason);
  });
  process.on('SIGINT', () => {
    console.log('[server] 正在关闭...');
    httpServer.close();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    httpServer.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('[server] 启动失败:', err);
  process.exit(1);
});
