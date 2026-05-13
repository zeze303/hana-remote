// relay/public/js/app.js — 前端主逻辑

(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const $$ = (sel, ctx) => (ctx || document).querySelectorAll(sel);

  // ── 状态 ──
  const state = {
    ws: null,
    connected: false,
    workerOnline: false,
    mode: 'browse',       // 'browse' | 'edit'
    token: localStorage.getItem('token'),
    tabs: [],             // { id, type: 'chat'|'file', path?, label }
    activeTab: null,
    editors: {},          // tabId → monaco editor instance
    treeExpanded: {},     // path → true/false
    sessions: [],         // { id, title, hanakoSessionPath, ... }
    activeSessionId: null,
  };

  // ── DOM 引用 ──
  const statusDot = $('statusDot');
  const statusLabel = $('statusLabel');
  const modeToggle = $('modeToggle');
  const modeLabel = $('modeLabel');
  const fileTree = $('fileTree');
  const tabsEl = $('tabs');
  const chatMessages = $('chatMessages');
  const chatInput = $('chatInput');
  const chatSendBtn = $('chatSendBtn');
  const refreshTreeBtn = $('refreshTreeBtn');
  const searchInput = $('searchInput');
  const searchClearBtn = $('searchClearBtn');
  const searchResults = $('searchResults');
  const sessionSelect = $('sessionSelect');
  const sessionNewBtn = $('sessionNewBtn');
  const sessionDelBtn = $('sessionDelBtn');
  const sessionStats = $('sessionStats');
  const logoutBtn = $('logoutBtn');

  // ── 搜索状态 ──
  let searchTimeout = null;
  let searchMsgId = null;
  let searchActive = false;

  // ── 剪贴板状态 ──
  let clipboardSetMsgId = null;
  let clipboardGetMsgId = null;
  let clipboardGetTabId = null;

  // ========================================
  //  WebSocket 连接
  // ========================================

  function connectWS() {
    if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) return;

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${location.host}`;
    const ws = new WebSocket(wsUrl);
    state.ws = ws;

    setStatus('yellow', '连接中...');

    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: 'auth', role: 'client', token: state.token,
      }));
    };

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        handleMessage(msg);
      } catch (err) {
        console.error('WS parse error:', err);
      }
    };

    ws.onclose = () => {
      state.connected = false;
      if (state.ws === ws) {
        setStatus('red', '连接断开');
        disableChat(true);
        setTimeout(connectWS, 3000);
      }
    };

    ws.onerror = () => {};
  }

  function setStatus(color, label) {
    statusDot.className = `dot ${color}`;
    statusLabel.textContent = label;
  }

  function handleMessage(msg) {
    if (msg.type === 'auth' && msg.ok) {
      state.connected = true;
      state.workerOnline = msg.payload.workerOnline;
      setStatus(msg.payload.workerOnline ? 'green' : 'yellow',
        msg.payload.workerOnline ? '工作电脑在线' : '工作电脑未连接');
      disableChat(!msg.payload.workerOnline);
      // 连接成功后自动加载文件树（若未加载）
      if (msg.payload.workerOnline && fileTree.children.length < 2) {
        reloadTree();
      }
      // 拉取会话列表和聊天历史
      if (msg.payload.workerOnline) {
        setTimeout(requestSessionList, 300);
      }
      return;
    }

    if (msg.type === 'worker_connected') {
      state.workerOnline = true;
      setStatus('green', '工作电脑在线');
      disableChat(false);
      // 插件重连后自动刷新文件树
      reloadTree();
      // 拉取会话列表
      setTimeout(requestSessionList, 300);
      return;
    }

    if (msg.type === 'worker_disconnected') {
      state.workerOnline = false;
      setStatus('yellow', '工作电脑未连接');
      disableChat(true);
      return;
    }

    // 聊天回复
    if (msg.type === 'chat') {
      handleChatResponse(msg);
      return;
    }

    // 文件树回复
    if (msg.type === 'file_tree' && msg.ok) {
      if (treeMsgCallback && treeMsgCallback.path === '') {
        // 根目录（盘符列表）→ 直接渲染
        renderTree(msg.payload.children || []);
        treeMsgCallback = null;
      } else {
        // 子目录 → 渲染到对应容器
        renderTreeChildren(msg.payload);
      }
      return;
    }

    // 文件读取回复
    if (msg.type === 'file_read') {
      handleFileReadResponse(msg);
      return;
    }

    // 文件写入回复
    if (msg.type === 'file_write') {
      handleFileWriteResponse(msg);
      return;
    }

    // 文件状态回复
    if (msg.type === 'file_stat' && msg.ok) {
      handleFileStatResponse(msg);
      return;
    }

    // 搜索回复
    if (msg.type === 'file_search' && msg.ok) {
      handleFileSearchResponse(msg);
      return;
    }

    // 剪贴板回复
    if (msg.type === 'clipboard_set' && msg.ok && msg.id === clipboardSetMsgId) {
      clipboardSetMsgId = null;
      showToast('✅ 已复制到工作电脑剪贴板');
      return;
    }

    if (msg.type === 'clipboard_get' && msg.ok && msg.id === clipboardGetMsgId) {
      clipboardGetMsgId = null;
      const text = msg.payload?.text;
      if (!text) {
        showToast('工作电脑剪贴板为空');
      } else {
        const tabId = clipboardGetTabId;
        const editor = state.editors[tabId];
        if (editor) {
          editor.executeEdits('clipboard-paste', [{
            range: editor.getSelection() || editor.getModel().getFullModelRange(),
            text,
            forceMoveMarkers: true,
          }]);
        }
        showToast('✅ 已粘贴来自工作电脑的内容');
      }
      return;
    }

    // 会话管理回复
    if (msg.type === 'chat_session_list' && msg.ok) {
      handleSessionList(msg);
      return;
    }
    if (msg.type === 'chat_session_create' && msg.ok) {
      handleSessionCreate(msg);
      return;
    }
    if (msg.type === 'chat_session_delete' && msg.ok) {
      handleSessionDelete(msg);
      return;
    }
    if (msg.type === 'chat_session_switch' && msg.ok) {
      handleSessionSwitch(msg);
      return;
    }
    if (msg.type === 'session_stats' && msg.ok) {
      updateSessionStats(msg.payload);
      return;
    }

    // 聊天历史回复
    if (msg.type === 'chat_history' && msg.ok) {
      handleChatHistoryResponse(msg);
      return;
    }

    // 错误
    if (!msg.ok && msg.error) {
      showToast(msg.error);
    }
  }

  function sendMsg(type, payload) {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
      showToast('连接未就绪');
      return null;
    }
    const id = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    state.ws.send(JSON.stringify({ id, type, payload }));
    return id;
  }

  // ========================================
  //  Toast 通知
  // ========================================

  function showToast(text, duration) {
    let toast = $('toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'toast';
      toast.style.cssText = 'position:fixed;bottom:60px;left:50%;transform:translateX(-50%);background:#1a1a1e;border:1px solid #2a2a2e;color:#e4e4e7;padding:8px 16px;border-radius:8px;font-size:13px;z-index:9999;transition:opacity 0.3s;opacity:0;pointer-events:none;';
      document.body.appendChild(toast);
    }
    toast.textContent = text;
    toast.style.opacity = '1';
    clearTimeout(toast._hide);
    toast._hide = setTimeout(() => { toast.style.opacity = '0'; }, duration || 2500);
  }

  // ========================================
  //  模式切换
  // ========================================

  modeToggle.addEventListener('change', () => {
    state.mode = modeToggle.checked ? 'edit' : 'browse';
    modeLabel.textContent = state.mode === 'edit' ? '编辑' : '浏览';
    // 更新所有打开编辑器的只读状态
    Object.entries(state.editors).forEach(([tabId, editor]) => {
      editor.updateOptions({ readOnly: state.mode === 'browse' });
    });
    // 显示/隐藏保存按钮
    $$('.save-btn').forEach(el => {
      el.classList.toggle('show', state.mode === 'edit');
    });
  });

  // ========================================
  //  文件树
  // ========================================

  let treeMsgCallback = null;       // 等待树回复时的回调
  let fileReadCallbacks = {};
  let fileWriteCallback = null;

  function loadTree(path, level) {
    const id = sendMsg('file_tree', { path });
    if (id) {
      treeMsgCallback = { id, path, level: level || 0 };
    }
  }

  function reloadTree() {
    fileTree.innerHTML = '<div class="loading">加载驱动器列表...</div>';
    state.treeExpanded = {};
    loadRootTree();
  }

  function renderTree(children) {
    fileTree.innerHTML = '';
    children.forEach(child => {
      const node = createTreeNode(child, '');
      fileTree.appendChild(node);
    });
  }

  function renderTreeChildren(payload) {
    if (!treeMsgCallback) return;
    const { path, level } = treeMsgCallback;
    treeMsgCallback = null;

    const containerId = `children_${pathToId(path)}`;
    const container = $(containerId);
    if (!container) return;

    container.innerHTML = '';
    container.classList.add('open');

    const parentLevel = level || 0;
    (payload.children || []).forEach(child => {
      const node = createTreeNode(child, payload.path || '', parentLevel + 1);
      container.appendChild(node);
    });

    // 设置引导线位置
    const guideLeft = (20 + parentLevel * 18) + 'px';
    container.dataset.guide = guideLeft;
    container.style.setProperty('--guide-left', guideLeft);
    container.querySelectorAll('[data-branch]').forEach(el => {
      el.style.setProperty('--branch-left', guideLeft);
    });
  }

  function createTreeNode(item, parentPath, level) {
    level = level || 0;
    const fullPath = parentPath ? `${parentPath}${item.name}${item.type === 'dir' ? '\\' : ''}` : item.name;
    const indent = 12 + level * 18;
    const div = document.createElement('div');

    if (item.type === 'dir' || item.isDrive) {
      // 目录/盘符
      const label = document.createElement('div');
      label.className = 'tree-node';
      label.style.paddingLeft = indent + 'px';
      label.dataset.path = fullPath;
      if (level > 0) label.dataset.branch = '';

      const chevron = document.createElement('span');
      chevron.className = 'chevron empty';
      chevron.textContent = '▶';
      label.appendChild(chevron);

      const icon = document.createElement('span');
      icon.className = 'icon';
      icon.textContent = item.isDrive ? '💿' : '📁';
      label.appendChild(icon);

      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = item.label || item.name;
      label.appendChild(name);

      const childrenDiv = document.createElement('div');
      childrenDiv.className = 'tree-children';
      childrenDiv.id = `children_${pathToId(fullPath)}`;

      label.addEventListener('click', (e) => {
        e.stopPropagation();
        if (childrenDiv.classList.contains('open')) {
          childrenDiv.classList.remove('open');
          chevron.classList.remove('expanded');
        } else {
          chevron.classList.add('expanded');
          childrenDiv.classList.add('open');
          if (childrenDiv.children.length === 0) {
            const loading = document.createElement('div');
            loading.className = 'loading';
            loading.textContent = '⏳';
            childrenDiv.appendChild(loading);
            loadTree(fullPath, level + 1);
          }
        }
      });

      div.appendChild(label);
      div.appendChild(childrenDiv);
    } else {
      // 文件
      const label = document.createElement('div');
      label.className = 'tree-node';
      label.style.paddingLeft = indent + 'px';
      label.dataset.path = fullPath;
      if (level > 0) label.dataset.branch = '';

      const chevron = document.createElement('span');
      chevron.className = 'chevron empty';
      chevron.textContent = '';
      label.appendChild(chevron);

      const icon = document.createElement('span');
      icon.className = 'icon';
      // 按扩展名选图标
      const ext = fullPath.split('.').pop().toLowerCase();
      const fileIcons = { js: '📄', ts: '📘', json: '📋', html: '🌐', css: '🎨', md: '📝', py: '🐍', txt: '📄', xml: '📋', yml: '⚙', yaml: '⚙', cfg: '⚙', conf: '⚙', env: '🔒', gitignore: '🔒', log: '📋', csv: '📊', sql: '🗃', sh: '⚡', bat: '⚡', ps1: '⚡', go: '🔵', rs: '🦀', java: '☕', c: '⚙', cpp: '⚙', h: '⚙' };
      icon.textContent = fileIcons[ext] || '📄';
      label.appendChild(icon);

      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = item.name;
      // 显示文件大小
      if (item.size !== undefined && item.size > 0) {
        const sizeEl = document.createElement('span');
        sizeEl.style.cssText = 'margin-left:auto;font-size:11px;color:var(--text-muted)';
        sizeEl.textContent = formatSize(item.size);
        label.appendChild(sizeEl);
      }
      label.appendChild(name);

      label.addEventListener('click', (e) => {
        e.stopPropagation();
        $$('.tree-node.active').forEach(el => el.classList.remove('active'));
        label.classList.add('active');
        openFile(fullPath);
      });

      div.appendChild(label);
    }

    return div;
  }

  // 加载根目录（盘符）
  function loadRootTree() {
    const id = sendMsg('file_tree', { path: '' });
    if (id) {
      treeMsgCallback = { id, path: '' };
    }
  }

  function pathToId(p) {
    return p.replace(/[\\\/:.*#\[\]()$@!?&|]/g, '_');
  }

  function formatSize(bytes) {
    if (!bytes) return '';
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  }

  refreshTreeBtn.addEventListener('click', () => {
    hideSearchResults();
    reloadTree();
  });

  logoutBtn.addEventListener('click', () => {
    localStorage.removeItem('token');
    localStorage.removeItem('tokenExpires');
    window.location.href = '/';
  });

  // ── 搜索事件 ──
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    const val = searchInput.value.trim();
    searchClearBtn.hidden = !val;
    if (val.length < 2) {
      hideSearchResults();
      return;
    }
    searchTimeout = setTimeout(() => doSearch(val), 300);
  });

  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(searchTimeout);
      const val = searchInput.value.trim();
      if (val.length >= 2) doSearch(val);
    }
    if (e.key === 'Escape') {
      hideSearchResults();
      searchInput.value = '';
      searchClearBtn.hidden = true;
      searchInput.blur();
    }
  });

  searchClearBtn.addEventListener('click', () => {
    searchInput.value = '';
    searchClearBtn.hidden = true;
    hideSearchResults();
    searchInput.focus();
  });

  // ── 会话事件 ──
  sessionSelect.addEventListener('change', () => {
    const sessionId = sessionSelect.value;
    if (sessionId && sessionId !== state.activeSessionId) {
      switchSession(sessionId);
    }
  });

  sessionNewBtn.addEventListener('click', () => {
    sendMsg('chat_session_create', {});
    showToast('正在创建新对话...');
  });

  sessionDelBtn.addEventListener('click', () => {
    if (!state.activeSessionId || state.sessions.length <= 1) {
      showToast('至少保留一个对话');
      return;
    }
    if (confirm('删除这个对话？聊天记录也会清除。')) {
      sendMsg('chat_session_delete', { sessionId: state.activeSessionId });
    }
  });

  // ========================================
  //  文件编辑
  // ========================================

  let monacoReady = false;
  let monacoQueue = [];

  // 加载 Monaco
  require.config({ paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs' } });
  require(['vs/editor/editor.main'], () => {
    monacoReady = true;
    monacoQueue.forEach(fn => fn());
    monacoQueue = [];
  });

  function openFile(filePath) {
    const tabId = `file_${pathToId(filePath)}`;
    const label = filePath.split('\\').pop() || filePath;

    // 如果标签已存在，直接切换
    const existing = state.tabs.find(t => t.id === tabId);
    if (existing) {
      switchTab(tabId);
      return;
    }

    addTab(tabId, 'file', { path: filePath, label });
    switchTab(tabId);

    // 请求读取文件
    const panel = createFilePanel(tabId);
    panel.innerHTML = '<div class="loading">读取中...</div>';

    const msgId = sendMsg('file_read', { path: filePath });
    if (msgId) {
      fileReadCallbacks[msgId] = { tabId, filePath };
    }
  }

  function handleFileReadResponse(msg) {
    const cb = fileReadCallbacks[msg.id];
    if (!cb) return;
    delete fileReadCallbacks[msg.id];

    if (!msg.ok || msg.payload.error) {
      const errorText = msg.payload ? msg.payload.error : '读取失败';
      const panel = $(`panel_${cb.tabId}`);
      if (panel) {
        panel.innerHTML = `<div class="file-info-card">${escapeHtml(errorText)}</div>`;
      }
      return;
    }

    const { content, isBinary, size } = msg.payload;

    if (isBinary) {
      const panel = $(`panel_${cb.tabId}`);
      if (panel) {
        panel.innerHTML = `<div class="file-info-card">
          <div>⚠️ 二进制文件，无法预览</div>
          <div class="file-detail">${formatSize(size)}</div>
        </div>`;
      }
      return;
    }

    initEditor(cb.tabId, cb.filePath, content);
  }

  function createFilePanel(tabId) {
    let panel = $(`panel_${tabId}`);
    if (!panel) {
      panel = document.createElement('div');
      panel.id = `panel_${tabId}`;
      panel.className = 'panel';
      $('panels').appendChild(panel);
    }
    return panel;
  }

  function initEditor(tabId, filePath, content) {
    createFilePanel(tabId);
    const panel = $(`panel_${tabId}`);
    panel.innerHTML = '';

    const container = document.createElement('div');
    container.className = 'file-editor-container';
    container.id = `editorWrap_${tabId}`;

    const header = document.createElement('div');
    header.className = 'file-editor-header';
    header.innerHTML = `
      <span class="file-path">${escapeHtml(filePath)}</span>
      <span class="file-info">${content ? formatSize(new Blob([content]).size) : ''}</span>
      <button class="clip-btn" data-tab="${tabId}" title="复制到工作电脑剪贴板">📋</button>
      <button class="paste-btn" data-tab="${tabId}" title="从工作电脑剪贴板获取内容">📋↑</button>
      <button class="save-btn ${state.mode === 'edit' ? 'show' : ''}" data-tab="${tabId}">保存</button>
    `;
    container.appendChild(header);

    const editorDiv = document.createElement('div');
    editorDiv.className = 'monaco-container';
    editorDiv.id = `monaco_${tabId}`;
    container.appendChild(editorDiv);

    panel.appendChild(container);

    // 保存按钮
    header.querySelector('.save-btn').addEventListener('click', () => {
      saveFile(tabId, filePath);
    });

    // 剪贴板复制按钮
    header.querySelector('.clip-btn').addEventListener('click', () => {
      const editor = state.editors[tabId];
      if (!editor) return;
      const text = editor.getSelection()
        ? editor.getModel().getValueInRange(editor.getSelection())
        : editor.getValue();
      if (!text) {
        showToast('没有可复制的内容');
        return;
      }
      clipboardSetMsgId = sendMsg('clipboard_set', { text });
      if (clipboardSetMsgId) showToast('📋 正在发送到工作电脑...');
    });

    // 剪贴板粘贴按钮
    header.querySelector('.paste-btn').addEventListener('click', () => {
      const editor = state.editors[tabId];
      if (!editor) return;
      clipboardGetMsgId = sendMsg('clipboard_get', {});
      clipboardGetTabId = tabId;
      if (clipboardGetMsgId) showToast('📋 正在获取工作电脑剪贴板...');
    });

    // 创建 Monaco 编辑器
    const lang = guessLang(filePath);

    function createEditor() {
      const editor = monaco.editor.create(editorDiv, {
        value: content || '',
        language: lang,
        theme: 'vs-dark',
        fontSize: 13,
        fontFamily: 'var(--font-mono)',
        lineNumbers: 'on',
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        wordWrap: 'on',
        readOnly: state.mode === 'browse',
        automaticLayout: true,
        padding: { top: 8 },
      });
      state.editors[tabId] = editor;
    }

    if (monacoReady) {
      createEditor();
    } else {
      monacoQueue.push(createEditor);
    }

    // 窗口大小变化时自动调整
    const resizeObserver = new ResizeObserver(() => {
      if (state.editors[tabId]) {
        state.editors[tabId].layout();
      }
    });
    resizeObserver.observe(editorDiv);
  }

  function guessLang(filePath) {
    const ext = filePath.split('.').pop().toLowerCase();
    const langMap = {
      js: 'javascript', ts: 'typescript', jsx: 'javascript', tsx: 'typescript',
      html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less',
      json: 'json', xml: 'xml', yml: 'yaml', yaml: 'yaml', md: 'markdown',
      py: 'python', rb: 'ruby', rs: 'rust', go: 'go', java: 'java',
      c: 'c', cpp: 'cpp', h: 'c', cs: 'csharp', php: 'php',
      sh: 'shell', bash: 'shell', ps1: 'powershell', bat: 'bat',
      sql: 'sql', graphql: 'graphql', env: 'ini', ini: 'ini',
      vue: 'html', svelte: 'html', svg: 'xml',
    };
    const base = filePath.split('\\').pop().toLowerCase();
    if (base === 'makefile') return 'makefile';
    if (base === 'dockerfile') return 'dockerfile';
    if (base === '.gitignore') return 'ignore';
    return langMap[ext] || 'plaintext';
  }

  function saveFile(tabId, filePath) {
    const editor = state.editors[tabId];
    if (!editor) return;

    const content = editor.getValue();
    if (fileWriteCallback) {
      showToast('正在保存，请稍后...');
      return;
    }

    const msgId = sendMsg('file_write', { path: filePath, content });
    if (msgId) {
      fileWriteCallback = { msgId, tabId };
      showToast('保存中...');
    }
  }

  function handleFileWriteResponse(msg) {
    if (!fileWriteCallback || fileWriteCallback.msgId !== msg.id) return;
    const { tabId } = fileWriteCallback;
    fileWriteCallback = null;

    if (msg.ok) {
      showToast('✅ 保存成功');
    } else {
      showToast('❌ 保存失败: ' + (msg.payload?.error || '未知错误'));
    }
  }

  function handleFileStatResponse(msg) {
    // 简单处理，暂时不做额外操作
  }

  // ========================================
  //  搜索
  // ========================================

  function doSearch(query) {
    searchActive = true;
    fileTree.style.display = 'none';
    searchResults.hidden = false;
    searchResults.innerHTML = '<div class="loading">搜索中...</div>';

    searchMsgId = sendMsg('file_search', {
      query,
      rootPath: '',  // 从盘符开始
      maxResults: 100,
      maxDepth: 4,
    });
  }

  function handleFileSearchResponse(msg) {
    if (msg.id !== searchMsgId) return;
    searchMsgId = null;

    const p = msg.payload;
    if (!p || !p.results || p.results.length === 0) {
      searchResults.innerHTML = '<div class="search-empty">未找到匹配的文件</div>';
      return;
    }

    let html = '';
    for (const r of p.results) {
      const icon = r.type === 'dir' ? '📁' : '📄';
      const typeLabel = r.type === 'dir' ? '目录' : '文件';
      html += `<div class="search-result-item" data-path="${escapeAttr(r.path)}" data-type="${r.type}">
        <div class="search-result-name">${icon} ${escapeHtml(r.name)}</div>
        <div class="search-result-path">${escapeHtml(r.path)} <span class="search-result-type ${r.type}">${typeLabel}</span></div>
      </div>`;
    }

    if (p.truncated) {
      html += '<div class="search-truncated">结果过多，仅显示前 100 条</div>';
    }

    searchResults.innerHTML = html;

    // 点击打开文件
    searchResults.querySelectorAll('.search-result-item').forEach(el => {
      el.addEventListener('click', () => {
        const path = el.dataset.path;
        const type = el.dataset.type;
        if (type === 'file') {
          openFile(path);
        }
        hideSearchResults();
      });
    });
  }

  function hideSearchResults() {
    searchActive = false;
    searchResults.hidden = true;
    searchInput.value = '';
    searchClearBtn.hidden = true;
    fileTree.style.display = '';
  }

  function escapeHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function escapeAttr(str) {
    return String(str).replace(/"/g, '&quot;').replace(/&/g, '&amp;');
  }

  // ========================================
  //  标签管理
  // ========================================

  function addTab(id, type, opts = {}) {
    if (state.tabs.find(t => t.id === id)) return;
    state.tabs.push({ id, type, ...opts });
    renderTabs();
  }

  function removeTab(id) {
    state.tabs = state.tabs.filter(t => t.id !== id);
    if (state.activeTab === id) {
      state.activeTab = state.tabs.length > 0 ? state.tabs[state.tabs.length - 1].id : null;
    }
    // 销毁编辑器
    if (state.editors[id]) {
      state.editors[id].dispose();
      delete state.editors[id];
    }
    const panel = $(`panel_${id}`);
    if (panel) panel.remove();
    renderTabs();
    showPanel(state.activeTab);
  }

  function switchTab(id) {
    state.activeTab = id;
    renderTabs();
    showPanel(id);
  }

  function renderTabs() {
    tabsEl.innerHTML = '';
    state.tabs.forEach(tab => {
      const el = document.createElement('div');
      el.className = `tab ${tab.id === state.activeTab ? 'active' : ''}`;
      el.dataset.tabId = tab.id;

      const icon = '📄';
      const label = tab.label || '文件';

      el.innerHTML = `${icon} ${escapeHtml(label)} <span class="tab-close">×</span>`;

      el.addEventListener('click', () => switchTab(tab.id));
      el.querySelector('.tab-close').addEventListener('click', (e) => {
        e.stopPropagation();
        removeTab(tab.id);
      });

      tabsEl.appendChild(el);
    });
  }

  function showPanel(id) {
    $$('.panel').forEach(el => el.classList.remove('active'));
    if (id) {
      const panel = $(`panel_${id}`);
      if (panel) panel.classList.add('active');
    } else {
      // 没有标签时显示欢迎
      const welcome = $('welcome');
      if (welcome) welcome.classList.add('active');
    }
  }

  // ========================================
  //  聊天
  // ========================================

  let chatMsgId = null;

  function disableChat(disabled) {
    chatInput.disabled = disabled;
    if (disabled) {
      chatInput.placeholder = '工作电脑未连接';
    } else {
      chatInput.placeholder = '输入消息...';
    }
  }

  let chatMsgTimeout = null;
  let chatStreamTimeout = null;

  function clearChatStreamTimeout() {
    if (chatStreamTimeout) { clearTimeout(chatStreamTimeout); chatStreamTimeout = null; }
  }

  function resetChatStreamTimeout() {
    clearChatStreamTimeout();
    // 60 秒没新 chunk 自动结束流
    chatStreamTimeout = setTimeout(() => {
      if (chatMsgId) {
        const lastMsg = chatMessages.querySelector('.chat-msg.hanako:last-child');
        if (lastMsg) lastMsg.dataset.done = 'true';
        clearChatMsgLock();
        chatInput.disabled = false;
        setTimeout(requestSessionStats, 500);
      }
    }, 60000);
  }

  function sendChat() {
    const text = chatInput.value.trim();
    if (!text) return;

    // 如果上一次消息还没收到回复，先清掉（超时保护）
    if (chatMsgId) {
      clearTimeout(chatMsgTimeout);
      chatMsgId = null;
    }

    chatInput.value = '';

    // 标记 /compact 以便完成后弹提示
    if (text.trim() === '/compact') {
      state._lastWasCompact = true;
    } else {
      state._lastWasCompact = false;
    }

    // 发送前刷新一次统计（先更新用户消息后的状态）
    setTimeout(requestSessionStats, 300);

    // 显示用户消息
    addChatMsg('user', text);
    chatMsgId = sendMsg('chat', { text });

    // 30 秒超时：没收到回复就清掉，允许重新发送
    if (chatMsgId) {
      clearTimeout(chatMsgTimeout);
      chatMsgTimeout = setTimeout(() => {
        chatMsgId = null;
        chatInput.disabled = false;
      }, 30000);
    }
  }

  function clearChatMsgLock() {
    clearTimeout(chatMsgTimeout);
    chatMsgId = null;
  }

  function handleChatResponse(msg) {
    if (msg.id !== chatMsgId) return;
    const p = msg.payload || {};

    // 错误处理
    if (!msg.ok || p.error) {
      addChatMsg('hanako error', '⚠️ ' + (p.error || '请求失败'));
      clearChatMsgLock();
      chatInput.disabled = false;
      return;
    }

    // 收到任何数据都重设流超时
    resetChatStreamTimeout();

    // 思考过程
    if (p.thinking !== undefined) {
      let thinkEl = chatMessages.querySelector('.chat-thinking:last-child');
      if (!thinkEl) {
        thinkEl = createThinkingBlock();
        chatMessages.appendChild(thinkEl);
      }
      const pre = thinkEl.querySelector('pre');
      if (pre) pre.textContent += p.thinking;
      chatMessages.scrollTop = chatMessages.scrollHeight;
      saveChatHistory();
      return;
    }

    if (p.done) {
      // 标记最后一条消息已完成
      const lastMsg = chatMessages.querySelector('.chat-msg.hanako:last-child');
      if (lastMsg) lastMsg.dataset.done = 'true';
      clearChatStreamTimeout();
      clearChatMsgLock();
      chatInput.disabled = false;
      // /compact 完成后弹提示
      if (state._lastWasCompact) {
        state._lastWasCompact = false;
        showToast('✅ 对话已压缩');
        // 延迟请求统计，等插件写完文件
        setTimeout(requestSessionStats, 1000);
      } else {
        // 普通消息完成后更新上下文统计
        setTimeout(requestSessionStats, 500);
      }
      return;
    }

    // 找到最后一条 Hanako 消息或创建新的
    let lastMsg = chatMessages.querySelector('.chat-msg.hanako:last-child');
    if (!lastMsg || lastMsg.dataset.done === 'true') {
      lastMsg = document.createElement('div');
      lastMsg.className = 'chat-msg hanako';
      lastMsg.dataset.done = 'false';
      chatMessages.appendChild(lastMsg);
    }

    lastMsg.textContent += p.text || '';
    chatMessages.scrollTop = chatMessages.scrollHeight;
    saveChatHistory();
  }

  function renderSessionSelect(sessions, activeId) {
    sessionSelect.innerHTML = '';
    for (const s of sessions) {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.title || s.id;
      if (s.id === activeId) opt.selected = true;
      sessionSelect.appendChild(opt);
    }
  }

  function handleSessionList(msg) {
    const p = msg.payload;
    state.sessions = p.sessions || [];
    state.activeSessionId = p.active;
    renderSessionSelect(state.sessions, state.activeSessionId);
    setTimeout(requestSessionStats, 200);
  }

  function handleSessionCreate(msg) {
    const p = msg.payload;
    state.sessions = p.sessions || [];
    state.activeSessionId = p.active;
    renderSessionSelect(state.sessions, state.activeSessionId);
    // 清空聊天面板
    chatMessages.innerHTML = '';
    saveChatHistory();
    showToast('✅ 新对话已创建');
  }

  function handleSessionDelete(msg) {
    const p = msg.payload;
    state.sessions = p.sessions || [];
    state.activeSessionId = p.active;
    renderSessionSelect(state.sessions, state.activeSessionId);
    // 清空并重新加载历史
    chatMessages.innerHTML = '';
    saveChatHistory();
    if (state.activeSessionId) {
      setTimeout(() => sendMsg('chat_history', { sessionId: state.activeSessionId }), 200);
    }
    showToast('对话已删除');
  }

  function handleSessionSwitch(msg) {
    const p = msg.payload;
    state.sessions = p.sessions || [];
    state.activeSessionId = p.active;
    renderSessionSelect(state.sessions, state.activeSessionId);
    // 替换聊天面板内容
    chatMessages.innerHTML = '';
    const entries = p.entries || [];
    for (const entry of entries) {
      if (entry.type === 'thinking') {
        const el = createThinkingBlock();
        const pre = el.querySelector('pre');
        if (pre) pre.textContent = entry.text || '';
        chatMessages.appendChild(el);
      } else {
        addChatMsg(entry.type, entry.text || '');
      }
    }
    chatMessages.scrollTop = chatMessages.scrollHeight;
    // 获取上下文统计
    setTimeout(requestSessionStats, 200);
  }

  function handleChatHistoryResponse(msg) {
    const entries = msg.payload?.entries;
    if (!entries || !Array.isArray(entries) || entries.length === 0) return;
    // 已加载过 localStorage 历史，追加服务端历史中缺失的部分
    const localCount = chatMessages.children.length;
    const serverEntries = localCount > 0 ? entries.slice(-(entries.length - localCount)) : entries;
    if (serverEntries.length === 0) return;
    for (const entry of serverEntries) {
      if (entry.type === 'thinking') {
        const el = createThinkingBlock();
        const pre = el.querySelector('pre');
        if (pre) pre.textContent = entry.text || '';
        chatMessages.appendChild(el);
      } else {
        addChatMsg(entry.type, entry.text || '');
      }
    }
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function requestChatHistory() {
    sendMsg('chat_history', { sessionId: state.activeSessionId });
  }

  function requestSessionList() {
    sendMsg('chat_session_list', {});
  }

  function switchSession(sessionId) {
    sendMsg('chat_session_switch', { sessionId });
  }

  function requestSessionStats() {
    if (!state.activeSessionId) return;
    sendMsg('session_stats', {});
  }

  // 每 30 秒自动刷新一次上下文统计
  setInterval(requestSessionStats, 30000);

  function updateSessionStats(payload) {
    if (!sessionStats) return;
    const { tokens, msgs } = payload || {};
    if (tokens > 0) {
      const label = tokens >= 1000 ? (tokens / 1000).toFixed(1) + 'K' : tokens;
      let dotClass;
      if (tokens < 100000) dotClass = 'ok';
      else if (tokens < 500000) dotClass = 'warn';
      else dotClass = 'danger';
      sessionStats.innerHTML = `<span class="stat-dot ${dotClass}"></span>${label} tokens · ${msgs} 条消息`;
    } else {
      sessionStats.innerHTML = '';
    }
  }

  function createThinkingBlock() {
    const details = document.createElement('details');
    details.className = 'chat-thinking';
    details.open = false;
    const summary = document.createElement('summary');
    summary.textContent = '思考过程';
    const pre = document.createElement('pre');
    details.appendChild(summary);
    details.appendChild(pre);
    return details;
  }

  function addChatMsg(type, text) {
    const div = document.createElement('div');
    div.className = `chat-msg ${type}`;
    div.textContent = text;
    div.dataset.done = 'true';
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  // 发送按钮：不用 disabled 属性（用 JS 控制逻辑）
  chatSendBtn.removeAttribute('disabled');
  chatSendBtn.addEventListener('click', (e) => {
    if (!state.workerOnline || !state.connected) {
      showToast('工作电脑未连接');
      return;
    }
    sendChat();
  });
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!state.workerOnline || !state.connected) {
        showToast('工作电脑未连接');
        return;
      }
      sendChat();
    }
  });

  // 聊天面板始终可见，不需额外操作
  chatInput.addEventListener('focus', () => {});

  // ========================================
  //  侧栏拖动
  // ========================================

  function initSplitter(id, targetId, minW, maxRatio, fromRight) {
    const splitter = $(id);
    const target = $(targetId);
    if (!splitter || !target) return;
    let dragging = false;

    splitter.addEventListener('mousedown', (e) => {
      e.preventDefault();
      dragging = true;
      splitter.classList.add('active');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      let width;
      if (fromRight) {
        // 从右侧拖入：计算右边缘位置
        width = Math.max(minW, Math.min(window.innerWidth - e.clientX - 2, window.innerWidth * maxRatio));
      } else {
        width = Math.max(minW, Math.min(e.clientX - 2, window.innerWidth * maxRatio));
      }
      target.style.width = width + 'px';
      target.style.flexShrink = '0';
    });

    document.addEventListener('mouseup', () => {
      if (dragging) {
        dragging = false;
        splitter.classList.remove('active');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    });
  }

  // ========================================
  //  工具函数
  // ========================================

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ========================================
  //  聊天历史持久化
  // ========================================

  /** 保存聊天消息到 localStorage（带防抖） */
  let _saveTimer = null;
  function saveChatHistory() {
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(() => {
      _saveTimer = null;
      const entries = [];
      chatMessages.childNodes.forEach(node => {
        if (node.classList?.contains('chat-msg')) {
          entries.push({ type: node.className.replace('chat-msg ', ''), text: node.textContent });
        } else if (node.classList?.contains('chat-thinking')) {
          const pre = node.querySelector('pre');
          entries.push({ type: 'thinking', text: pre ? pre.textContent : '' });
        }
      });
      try {
        localStorage.setItem('chatHistory', JSON.stringify(entries));
      } catch {}
    }, 300);
  }

  /** 从 localStorage 恢复聊天消息 */
  function loadChatHistory() {
    try {
      const raw = localStorage.getItem('chatHistory');
      if (!raw) return;
      const entries = JSON.parse(raw);
      if (!Array.isArray(entries)) return;

      chatMessages.innerHTML = '';
      for (const entry of entries) {
        if (entry.type === 'thinking') {
          const el = createThinkingBlock();
          const pre = el.querySelector('pre');
          if (pre) pre.textContent = entry.text || '';
          chatMessages.appendChild(el);
        } else {
          const div = document.createElement('div');
          div.className = `chat-msg ${entry.type}`;
          div.textContent = entry.text || '';
          div.dataset.done = 'true';
          chatMessages.appendChild(div);
        }
      }
      chatMessages.scrollTop = chatMessages.scrollHeight;
    } catch {}
  }

  // ========================================
  //  初始化
  // ========================================

  let _lastActivity = Date.now();
  const SESSION_TIMEOUT = 30 * 60 * 1000; // 30 分钟

  function resetActivity() { _lastActivity = Date.now(); }

  function init() {
    // 检查登录
    if (!state.token) {
      window.location.href = '/';
      return;
    }

    // 恢复聊天历史
    loadChatHistory();

    // 连接 WebSocket（连接成功后会触发文件树加载）
    connectWS();

    // 初始化侧栏拖动
    initSplitter('splitter', 'sidebar', 120, 0.6);
    initSplitter('chatSplitter', 'chatPanel', 200, 0.5, true);

    // 占位提示
    fileTree.innerHTML = '<div class="loading">等待连接...</div>';

    // 展示欢迎面板
    showPanel(null);

    // ── Session 超时检测 ──
    ['click', 'keydown', 'scroll', 'mousemove', 'touchstart'].forEach(ev => {
      document.addEventListener(ev, resetActivity, { passive: true });
    });

    setInterval(() => {
      if (Date.now() - _lastActivity > SESSION_TIMEOUT) {
        localStorage.removeItem('token');
        localStorage.removeItem('tokenExpires');
        window.location.href = '/';
      }
    }, 60000); // 每分钟检查一次
  }

  // 页面加载完成后初始化
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // 暴露接口给调试
  window.__hana = { state, connectWS, loadTree, loadRootTree };
})();
