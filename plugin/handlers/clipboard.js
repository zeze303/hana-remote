// plugin/handlers/clipboard.js — 远程剪贴板操作
// clipboard_set: 从浏览器推送文本到工作电脑剪贴板
// clipboard_get: 从工作电脑剪贴板读取文本

const { execSync } = require('child_process');

/**
 * 将文本写入 Windows 剪贴板
 */
function setClipboard(text) {
  // Windows 的 clip 命令接收 stdin
  const process = require('child_process').spawn('clip');
  process.stdin.write(text);
  process.stdin.end();
  return new Promise((resolve, reject) => {
    process.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`clip 退出码: ${code}`));
    });
    process.on('error', reject);
  });
}

/**
 * 从 Windows 剪贴板读取文本
 */
function getClipboard() {
  try {
    const result = execSync('powershell.exe -NoProfile -Command "Get-Clipboard"', {
      encoding: 'utf-8',
      timeout: 5000,
    });
    return result.trim();
  } catch (e) {
    throw new Error(`读取剪贴板失败: ${e.message}`);
  }
}

/**
 * clipboard_set — 设置剪贴板内容
 */
async function handleClipboardSet(payload) {
  const { text } = payload || {};
  if (text === undefined || text === null) {
    return { error: '缺少文本内容' };
  }

  await setClipboard(String(text));
  return { ok: true, size: String(text).length };
}

/**
 * clipboard_get — 读取剪贴板内容
 */
async function handleClipboardGet() {
  const text = getClipboard();
  return { text, size: text.length };
}

module.exports = {
  handleClipboardSet,
  handleClipboardGet,
};
