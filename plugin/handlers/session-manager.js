// plugin/handlers/session-manager.js — 会话管理
// 直接读取和复用 Hanako 桌面端的会话，实现桌面端 ↔ 网页端互通

const fs = require('fs');
const path = require('path');
const http = require('http');

let hanakoServerInfo = null;

function init(serverInfo) {
  hanakoServerInfo = serverInfo;
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
 */
async function listSessions() {
  const res = await httpRequest('GET', '/api/sessions');
  if (res.status !== 200 || !Array.isArray(res.body)) {
    return [];
  }

  const sessions = [];
  for (const item of res.body) {
    const sessionPath = item.path;
    if (!sessionPath) continue;

    // 从文件路径中提取创建时间
    const fileName = path.basename(sessionPath, '.jsonl');
    // 格式: 2026-05-13T10-14-37-758Z_019e20d4-cdbe-764e-b0ea-95f35c04c168
    const timeStr = fileName.split('_')[0]?.replace(/T/g, 'T').replace(/-(\d{2})-(\d{2})-/, '-');
    let createdAt = 0;
    try {
      createdAt = new Date(fileName.split('_')[0].replace(/-/g, '-').replace(/T/, 'T')).getTime();
    } catch {}

    // 读取会话文件获取标题和消息数
    let title = '对话';
    let messageCount = 0;
    try {
      const content = fs.readFileSync(sessionPath, 'utf-8');
      const lines = content.trim().split('\n');
      for (const line of lines) {
        try {
          const msg = JSON.parse(line);
          if (msg.type === 'message' && msg.message) {
            messageCount++;
            // 第一条用户消息作为标题
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

  // 按创建时间倒序（最新的在前）
  sessions.sort((a, b) => b.createdAt - a.createdAt);
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
    console.log(`[session] getHistory: ${sessionPath}, ${lines.length} lines`);

    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        if (msg.type !== 'message' || !msg.message) continue;

        const role = msg.message.role;
        console.log(`[session]   line role=${role} id=${msg.id?.slice(0,8)}`);

        if (role === 'user') {
          const text = extractText(msg.message.content);
          console.log(`[session]   user text=${text?.slice(0,40)}`);
          if (text) entries.push({ type: 'user', text });
        } else if (role === 'assistant') {
          const text = extractText(msg.message.content);
          console.log(`[session]   assistant text=${text?.slice(0,40)}`);
          if (text) entries.push({ type: 'hanako', text });
        }
      } catch (e) {
        console.log(`[session]   parse error: ${e.message}`);
      }
    }

    console.log(`[session] getHistory done: ${entries.length} entries`);
    return entries;
  } catch (e) {
    console.error(`[session] getHistory error: ${e.message}`);
    return [];
  }
}

/**
 * 从 content 数组中提取纯文本
 */
function extractText(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    // 先从后往前找 text（最后一个 text 是完整回复）
    let lastText = '';
    for (const c of content) {
      if (c.type === 'text' && c.text) lastText = c.text;
    }
    if (lastText) return lastText;
    // 没有 text 就找 mood
    for (const c of content) {
      if (c.type === 'mood') return c.mood || '';
    }
  }
  return '';
}

module.exports = { init, listSessions, getHistory };
