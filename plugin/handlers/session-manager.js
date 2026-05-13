// plugin/handlers/session-manager.js — 会话管理
// 直接读取和复用 Hanako 桌面端的会话，实现桌面端 ↔ 网页端互通

const fs = require('fs');
const path = require('path');
const http = require('http');

let hanakoServerInfo = null;

// 会话列表缓存，避免每次请求都读所有 .jsonl 文件
let sessionsCache = null;
let sessionsCacheTime = 0;
const CACHE_TTL = 30000; // 30 秒

function init(serverInfo) {
  hanakoServerInfo = serverInfo;
  sessionsCache = null;
}

function invalidateCache() {
  sessionsCache = null;
}

function httpRequest(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    if (!hanakoServerInfo) return reject(new Error('Hanako 未初始化'));
    const options = {
      hostname: '127.0.0.1', port: hanakoServerInfo.port,
      path: apiPath, method,
      headers: { 'Authorization': `Bearer ${hanakoServerInfo.token}`, 'Content-Type': 'application/json' },
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

/**
 * 从 Hanako API 列出所有会话
 * 返回: [{ id, title, path, createdAt, messageCount }]
 * 结果缓存 30 秒，避免每次请求都重读所有 .jsonl
 */
async function listSessions(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && sessionsCache && (now - sessionsCacheTime < CACHE_TTL)) {
    return sessionsCache;
  }

  const res = await httpRequest('GET', '/api/sessions');
  if (res.status !== 200 || !Array.isArray(res.body)) {
    return sessionsCache || [];
  }

  const sessions = [];
  for (const item of res.body) {
    const sessionPath = item.path;
    if (!sessionPath) continue;

    const fileName = path.basename(sessionPath, '.jsonl');
    let createdAt = 0;
    try {
      createdAt = new Date(fileName.split('_')[0].replace(/-/g, '-')).getTime();
    } catch {}

    // 只读前 20KB 获取标题和消息数
    let title = '对话';
    let messageCount = 0;
    try {
      const fd = fs.openSync(sessionPath, 'r');
      const buf = Buffer.alloc(20480);
      const bytesRead = fs.readSync(fd, buf, 0, 20480, 0);
      fs.closeSync(fd);
      const partial = buf.toString('utf-8', 0, bytesRead);
      const lines = partial.split('\n');
      for (const line of lines) {
        try {
          const msg = JSON.parse(line);
          if (msg.type === 'message' && msg.message) {
            messageCount++;
            if (msg.message.role === 'user' && title === '对话') {
              const text = extractText(msg.message.content);
              if (text) title = text.replace(/\s+/g, ' ').trim().slice(0, 50);
            }
          }
        } catch {}
      }
    } catch {}

    sessions.push({
      id: fileName,
      title,
      hanakoSessionPath: sessionPath,
      createdAt,
      messageCount,
    });
  }

  sessions.sort((a, b) => b.createdAt - a.createdAt);
  sessionsCache = sessions;
  sessionsCacheTime = now;
  return sessions;
}

/**
 * 从 .jsonl 文件中提取聊天历史
 * 返回: [{ type: 'user'|'hanako', text }]
 */
function getHistory(sessionPath) {
  try {
    const content = fs.readFileSync(sessionPath, 'utf-8');
    const entries = [];
    const lines = content.trim().split('\n');

    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        if (msg.type !== 'message' || !msg.message) continue;

        const role = msg.message.role;
        if (role === 'user') {
          const text = extractText(msg.message.content);
          if (text) entries.push({ type: 'user', text });
        } else if (role === 'assistant') {
          const text = extractText(msg.message.content);
          if (text) entries.push({ type: 'hanako', text });
        }
      } catch {}
    }

    return entries;
  } catch {
    return [];
  }
}

function extractText(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    let lastText = '';
    for (const c of content) {
      if (c.type === 'text' && c.text) lastText = c.text;
    }
    if (lastText) return lastText;
    for (const c of content) {
      if (c.type === 'mood') return c.mood || '';
    }
  }
  return '';
}

module.exports = { init, listSessions, getHistory };
