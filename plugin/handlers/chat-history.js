// plugin/handlers/chat-history.js — 聊天历史持久化
// 保存到工作电脑本地文件，支持跨设备拉取

const fs = require('fs');
const path = require('path');

const HISTORY_DIR = path.join(__dirname, '..', '.hana-chat-history');
const HISTORY_FILE = path.join(HISTORY_DIR, 'history.json');

// 最多保留 500 条消息，防止文件过大
const MAX_ENTRIES = 500;

function ensureDir() {
  if (!fs.existsSync(HISTORY_DIR)) {
    fs.mkdirSync(HISTORY_DIR, { recursive: true });
  }
}

/**
 * 读取完整历史
 */
function loadHistory() {
  try {
    ensureDir();
    if (!fs.existsSync(HISTORY_FILE)) return [];
    const raw = fs.readFileSync(HISTORY_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

/**
 * 追加一条消息
 * @param {'user'|'hanako'|'error'} type
 * @param {string} text
 */
function addEntry(type, text) {
  try {
    const entries = loadHistory();
    entries.push({ type, text, time: Date.now() });

    // 截断
    if (entries.length > MAX_ENTRIES) {
      entries.splice(0, entries.length - MAX_ENTRIES);
    }

    ensureDir();
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(entries, null, 2), 'utf-8');
  } catch (e) {
    console.error('[chat-history] 保存失败:', e.message);
  }
}

/**
 * 清空历史
 */
function clearHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) fs.unlinkSync(HISTORY_FILE);
  } catch {}
}

module.exports = { loadHistory, addEntry, clearHistory };
