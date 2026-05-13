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
      return;
    }

    if (msg.type === 'worker_connected') {
      state.workerOnline = true;
      setStatus('green', '工作电脑在线');
      disableChat(false);
      // 插件重连后自动刷新文件树
      reloadTree();
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

  refreshTreeBtn.addEventListener('click', reloadTree);

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

      const icon = tab.type === 'chat' ? '💬' : '📄';
      const label = tab.type === 'chat' ? '聊天' : (tab.label || '文件');

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
    chatSendBtn.disabled = disabled;
    if (disabled) {
      chatInput.placeholder = '工作电脑未连接';
    } else {
      chatInput.placeholder = '输入消息...';
    }
  }

  function sendChat() {
    const text = chatInput.value.trim();
    if (!text || chatMsgId) return;

    chatInput.value = '';

    // 显示用户消息
    addChatMsg('user', text);
    chatMsgId = sendMsg('chat', { text });
  }

  function handleChatResponse(msg) {
    if (msg.id !== chatMsgId) return;
    const p = msg.payload || {};

    if (p.done) {
      chatMsgId = null;
      chatInput.disabled = false;
      chatSendBtn.disabled = !state.workerOnline;
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
  }

  function addChatMsg(type, text) {
    const div = document.createElement('div');
    div.className = `chat-msg ${type}`;
    div.textContent = text;
    div.dataset.done = 'true';
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  chatSendBtn.addEventListener('click', sendChat);
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChat();
    }
  });

  // 聊天标签
  function openChatTab() {
    const tabId = 'chat_tab';
    if (!state.tabs.find(t => t.id === tabId)) {
      addTab(tabId, 'chat');
    }
    switchTab(tabId);
  }

  // 点击聊天输入框时自动切到聊天标签
  chatInput.addEventListener('focus', () => {
    openChatTab();
  });

  // ========================================
  //  侧栏拖动
  // ========================================

  function initSplitter() {
    const splitter = $('splitter');
    const sidebar = $('sidebar');
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
      const width = Math.max(120, Math.min(e.clientX - 2, window.innerWidth * 0.6));
      sidebar.style.width = width + 'px';
      sidebar.style.flexShrink = '0';
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
  //  初始化
  // ========================================

  function init() {
    // 检查登录
    if (!state.token) {
      window.location.href = '/';
      return;
    }

    // 连接 WebSocket（连接成功后会触发文件树加载）
    connectWS();

    // 初始化侧栏拖动
    initSplitter();

    // 占位提示
    fileTree.innerHTML = '<div class="loading">等待连接...</div>';

    // 展示欢迎面板
    showPanel(null);
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
