// plugin/handlers/files.js — 文件系统操作
// file_tree / file_read / file_write / file_stat

const fs = require('fs');
const path = require('path');

// 文本文件扩展名白名单
const TEXT_EXTS = new Set([
  '.txt', '.md', '.js', '.ts', '.jsx', '.tsx', '.json', '.html', '.htm',
  '.css', '.scss', '.less', '.xml', '.yaml', '.yml', '.toml', '.ini',
  '.cfg', '.conf', '.env', '.gitignore', '.gitkeep', '.npmrc', '.editorconfig',
  '.py', '.java', '.c', '.cpp', '.h', '.hpp', '.cs', '.go', '.rs', '.rb',
  '.php', '.swift', '.kt', '.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd',
  '.sql', '.graphql', '.prisma', '.vue', '.svelte', '.svg',
  '.log', '.csv', '.tsv', '.diff', '.patch',
  'makefile', 'dockerfile',
]);
// Node.js 可读文本的扩展名（但需要额外处理）
const BINARY_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp',
  '.mp3', '.mp4', '.avi', '.mkv', '.mov', '.flv',
  '.zip', '.rar', '.7z', '.tar', '.gz', '.bz2',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.iso',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.wasm', '.o', '.obj', '.pyc',
]);

const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB

/**
 * 判断文件是否为文本文件
 */
function isTextFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const baseName = path.basename(filePath).toLowerCase();

  if (TEXT_EXTS.has(ext)) return true;
  if (TEXT_EXTS.has(baseName)) return true;
  if (BINARY_EXTS.has(ext)) return false;

  // 未知扩展名，读取前 512 字节判断
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(512);
    const bytesRead = fs.readSync(fd, buf, 0, 512, 0);
    fs.closeSync(fd);

    for (let i = 0; i < bytesRead; i++) {
      if (buf[i] === 0) return false; // 含空字节 → 二进制
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * 获取文件大小
 */
function getFileSize(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return stat.size;
  } catch {
    return 0;
  }
}

/**
 * 递归获取驱动器列表（Windows）
 */
function getDrives() {
  const drives = [];
  for (let i = 65; i <= 90; i++) {
    const letter = String.fromCharCode(i);
    const root = `${letter}:\\`;
    try {
      fs.accessSync(root, fs.constants.R_OK);
      // 获取卷标
      drives.push({
        name: root,
        type: 'drive',
        label: `${letter}:`,
      });
    } catch {
      // 不可读的盘符跳过
    }
  }
  return drives;
}

/**
 * file_tree — 列出目录内容
 */
async function handleFileTree(payload) {
  const reqPath = payload.path || '';
  const resolvedPath = reqPath.trim() || '';

  // 根目录 → 返回驱动器列表
  if (!resolvedPath || resolvedPath === '\\' || resolvedPath === '/') {
    const drives = getDrives();
    return {
      path: '',
      children: drives.map(d => ({
        name: d.name,
        type: 'dir',
        label: d.label,
        isDrive: true,
      })),
    };
  }

  // 展开路径（处理盘符简写 C: → C:\）
  let fullPath;
  if (/^[a-zA-Z]:\\?$/.test(resolvedPath)) {
    // 只有盘符，如 "C:" 或 "C:\"
    fullPath = resolvedPath.toUpperCase().replace(/\\?$/, '\\');
  } else {
    fullPath = resolvedPath;
  }

  // 检查目录是否存在
  try {
    const stat = fs.statSync(fullPath);
    if (!stat.isDirectory()) {
      return { path: fullPath, children: [], error: '不是一个目录' };
    }
  } catch {
    return { path: resolvedPath, children: [], error: '目录不存在或无法访问' };
  }

  // 读取目录
  let entries;
  try {
    entries = fs.readdirSync(fullPath, { withFileTypes: true });
  } catch {
    return { path: fullPath, children: [], error: '无法读取目录' };
  }

  const children = entries
    .filter(entry => !entry.name.startsWith('.')) // 隐藏文件/夹
    .map(entry => {
      const entryPath = path.join(fullPath, entry.name);
      let size = 0;
      let mtime = null;

      try {
        const s = fs.statSync(entryPath);
        size = s.size;
        mtime = s.mtime.toISOString();
      } catch {
        // 权限不足时跳过详细信息
      }

      return {
        name: entry.name,
        type: entry.isDirectory() ? 'dir' : 'file',
        size,
        mtime,
      };
    })
    .sort((a, b) => {
      // 目录排前面，各自按名称排序
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  return { path: fullPath, children };
}

/**
 * file_read — 读取文件内容
 */
async function handleFileRead(payload) {
  const filePath = payload.path;
  if (!filePath) return { path: filePath, error: '缺少路径' };

  // 检查文件是否存在
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return { path: filePath, error: '文件不存在或无法访问' };
  }

  if (stat.isDirectory()) {
    return { path: filePath, error: '这是一个目录' };
  }

  // 检查大小
  if (stat.size > MAX_FILE_SIZE) {
    return {
      path: filePath,
      error: `文件过大 (${(stat.size / 1024 / 1024).toFixed(1)}MB)，超过 2MB 限制`,
      size: stat.size,
    };
  }

  // 检查是否为文本文件
  if (!isTextFile(filePath)) {
    return {
      path: filePath,
      error: '二进制文件，无法预览',
      size: stat.size,
      isBinary: true,
    };
  }

  // 读取内容
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return {
      path: filePath,
      content,
      size: stat.size,
      mtime: stat.mtime.toISOString(),
    };
  } catch (e) {
    return { path: filePath, error: `读取失败: ${e.message}` };
  }
}

/**
 * file_write — 写入文件（先备份）
 */
async function handleFileWrite(payload) {
  const filePath = payload.path;
  const content = payload.content;

  if (!filePath) return { path: filePath, error: '缺少路径' };
  if (content === undefined || content === null) {
    return { path: filePath, error: '缺少内容' };
  }

  // 备份原文件
  try {
    if (fs.existsSync(filePath)) {
      const backupDir = path.join(path.dirname(filePath), '.hana-remote-backups');
      if (!fs.existsSync(backupDir)) {
        fs.mkdirSync(backupDir, { recursive: true });
      }
      const baseName = path.basename(filePath);
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPath = path.join(backupDir, `${baseName}_${timestamp}.bak`);
      fs.copyFileSync(filePath, backupPath);

      // 清理 7 天前的备份
      cleanupOldBackups(backupDir, 7);
    }
  } catch (e) {
    console.error(`[files] 备份失败 (非致命): ${e.message}`);
  }

  // 写入文件
  try {
    // 确保目录存在
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, content, 'utf-8');
    return { path: filePath, ok: true };
  } catch (e) {
    return { path: filePath, error: `写入失败: ${e.message}` };
  }
}

/**
 * file_stat — 获取文件/目录信息
 */
async function handleFileStat(payload) {
  const filePath = payload.path;
  if (!filePath) return { path: filePath, error: '缺少路径' };

  try {
    const stat = fs.statSync(filePath);
    return {
      path: filePath,
      type: stat.isDirectory() ? 'dir' : 'file',
      size: stat.size,
      mtime: stat.mtime.toISOString(),
      isBinary: stat.isDirectory() ? false : !isTextFile(filePath),
    };
  } catch {
    return { path: filePath, error: '无法访问' };
  }
}

/**
 * 清理过期备份（保留 N 天）
 */
function cleanupOldBackups(backupDir, days) {
  try {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const files = fs.readdirSync(backupDir);
    for (const file of files) {
      const filePath = path.join(backupDir, file);
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(filePath);
      }
    }
  } catch {
    // 非关键逻辑，忽略错误
  }
}

/**
 * file_search — 递归搜索文件
 * 从 rootPath 开始，按文件名模糊匹配 query
 */
async function handleFileSearch(payload) {
  const { query, rootPath, maxResults = 100, maxDepth = 4 } = payload;

  if (!query || !query.trim()) {
    return { results: [], error: '缺少搜索关键词' };
  }

  const keyword = query.trim().toLowerCase();
  const results = [];
  let stopped = false;

  function walk(dir, depth) {
    if (stopped || results.length >= maxResults) return;
    if (depth > maxDepth) return;

    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (stopped || results.length >= maxResults) return;

      const entryPath = path.join(dir, entry.name);
      const isDir = entry.isDirectory();

      // 文件名匹配（忽略隐藏文件）
      if (!entry.name.startsWith('.') && entry.name.toLowerCase().includes(keyword)) {
        try {
          const s = fs.statSync(entryPath);
          results.push({
            name: entry.name,
            path: entryPath,
            type: isDir ? 'dir' : 'file',
            size: isDir ? 0 : s.size,
            mtime: s.mtime.toISOString(),
          });
        } catch {
          // 跳过权限不足的条目
        }
      }

      // 递归目录
      if (isDir && !entry.name.startsWith('.')) {
        walk(entryPath, depth + 1);
      }
    }
  }

  const walkRoot = rootPath || 'C:\\';
  walk(walkRoot, 0);

  return {
    query,
    results: results.slice(0, maxResults),
    truncated: results.length >= maxResults,
  };
}

module.exports = {
  handleFileTree,
  handleFileRead,
  handleFileWrite,
  handleFileStat,
  handleFileSearch,
};
