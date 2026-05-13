// plugin/handlers/chat-history.js — 聊天历史持久化
// 保存到工作电脑本地文件，支持跨设备拉取

const fs = require('fs');
const path = require('path');

const HISTORY_DIR = path.join(__dirname, '..', '.hana-chat-history');

// 每个会话独立的历史文件：history_{sessionId}.json
// 最多保留 500 条消息，防止文件过大
const MAX_ENTRIES = 500;

let currentSessionId = null;

function getHistoryFile(sessionId) {
  return path.join(HISTORY_DIR, `history_${sessionId || 'default'}.json`);
}

function ensureDir() {
  if (!fs.existsSync(HISTORY_DIR)) {
    fs.mkdirSync(HISTORY_DIR, { recursive: true });
  }
}

/**
 * 设置当前会话 ID
 */
function setSession(sessionId) {
  currentSessionId = sessionId;
}

/**
 * 读取指定会话的历史
 */
function loadHistory(sessionId) {
  try {
    ensureDir();
    const file = getHistoryFile(sessionId || currentSessionId || 'default');
    if (!fs.existsSync(file)) return [];
    const raw = fs.readFileSync(file, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

/**
 * 追加一条消息到当前会话
 * @param {'user'|'hanako'|'error'} type
 * @param {string} text
 * @param {string} [sessionId]
 */
function addEntry(type, text, sessionId) {
  try {
    const sid = sessionId || currentSessionId || 'default';
    const file = getHistoryFile(sid);
    let entries = [];
    if (fs.existsSync(file)) {
      try { entries = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch {}
    }
    entries.push({ type, text, time: Date.now() });
    if (entries.length > MAX_ENTRIES) {
      entries.splice(0, entries.length - MAX_ENTRIES);
    }
    ensureDir();
    fs.writeFileSync(file, JSON.stringify(entries, null, 2), 'utf-8');
  } catch (e) {
    console.error('[chat-history] 保存失败:', e.message);
  }
}

/**
 * 清空指定会话的历史
 */
function clearHistory(sessionId) {
  try {
    const file = getHistoryFile(sessionId || currentSessionId || 'default');
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch {}
}

module.exports = { loadHistory, addEntry, clearHistory, setSession };
