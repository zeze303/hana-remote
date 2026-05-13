// plugin/handlers/session-manager.js — 对话会话管理
// 管理多个 Hanako 会话，每个会话有独立的 Hanako session 和聊天历史

const fs = require('fs');
const path = require('path');
const http = require('http');

const SESSIONS_DIR = path.join(__dirname, '..', '.hana-chat-sessions');
const SESSIONS_FILE = path.join(SESSIONS_DIR, 'sessions.json');
const MAX_SESSIONS = 20;

let hanakoServerInfo = null;

function init(serverInfo) {
  hanakoServerInfo = serverInfo;
}

function ensureDir() {
  if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  }
}

function loadSessions() {
  try {
    ensureDir();
    if (!fs.existsSync(SESSIONS_FILE)) return [];
    const raw = fs.readFileSync(SESSIONS_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch { return []; }
}

function saveSessions(sessions) {
  try {
    ensureDir();
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2), 'utf-8');
  } catch (e) {
    console.error('[session] 保存会话列表失败:', e.message);
  }
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
 * 列出所有会话
 */
function listSessions() {
  return loadSessions();
}

/**
 * 创建新会话
 */
async function createSession() {
  const sessions = loadSessions();
  if (sessions.length >= MAX_SESSIONS) {
    throw new Error(`会话数已达上限 (${MAX_SESSIONS})`);
  }

  // 创建 Hanako 会话
  const res = await httpRequest('POST', '/api/sessions/new');
  if (res.status !== 200 || !res.body?.path) {
    throw new Error(`创建 Hanako 会话失败: ${JSON.stringify(res.body).slice(0, 100)}`);
  }

  const hanakoSessionPath = res.body.path;
  const num = sessions.length + 1;
  const session = {
    id: `session_${Date.now()}`,
    title: `对话 ${num}`,
    hanakoSessionPath,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  sessions.push(session);
  saveSessions(sessions);

  console.log(`[session] 创建会话: ${session.id} → ${hanakoSessionPath}`);
  return session;
}

/**
 * 删除会话
 */
async function deleteSession(sessionId) {
  const sessions = loadSessions();
  const idx = sessions.findIndex(s => s.id === sessionId);
  if (idx === -1) throw new Error('会话不存在');

  const session = sessions[idx];
  sessions.splice(idx, 1);
  saveSessions(sessions);

  // 尝试删除 Hanako 上的会话（非关键步骤）
  try {
    const encodedPath = encodeURIComponent(session.hanakoSessionPath);
    await httpRequest('DELETE', `/api/sessions/${encodedPath}`);
  } catch {}

  console.log(`[session] 删除会话: ${session.id}`);
  return sessions;
}

/**
 * 重命名会话（基于第一条消息）
 */
function renameSession(sessionId, title) {
  const sessions = loadSessions();
  const session = sessions.find(s => s.id === sessionId);
  if (!session) return;
  session.title = title.slice(0, 50);
  session.updatedAt = Date.now();
  saveSessions(sessions);
}

module.exports = { init, listSessions, createSession, deleteSession, renameSession };
