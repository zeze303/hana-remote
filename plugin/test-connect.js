// test-connect.js — 独立测试启动脚本
// 连接到 Relay 中继，同时通过 HTTP API 连接本地 Hanako 服务

const HanaRemotePlugin = require('./index');
const { HanakoApi } = require('./hanako-api');

async function main() {
  // 尝试连接本地 Hanako
  const hanakoApi = new HanakoApi();
  try {
    await hanakoApi.ensureSession();
    console.log('[test] ✅ 已连接到本地 Hanako');
  } catch (e) {
    console.log('[test] ⚠️ 未检测到本地 Hanako:', e.message);
    console.log('[test] 聊天功能将不可用，文件浏览/编辑不受影响');
  }

  // 启动插件
  const plugin = new HanaRemotePlugin(hanakoApi);
  plugin.start({
    relayUrl: 'wss://hana-remote.onrender.com',
    workerSecret: 'CHVQGG7GlWrin57mOsylCWsh',
  });

  console.log('[test] 插件已启动，连接中...');

  // 全局错误捕获，防止插件静默崩溃
  process.on('uncaughtException', err => {
    console.error('[test] ⚠️ 未捕获的异常:', err.message, err.stack?.slice(0, 300));
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[test] ⚠️ 未捕获的 Promise 拒绝:', reason?.message || reason);
  });

  // 定期输出状态
  setInterval(() => {
    const ws = plugin.wsClient;
    console.log('[test] 状态:', ws && ws.connected ? '在线' : '离线',
      '| Hanako:', hanakoApi.ready ? '已连接' : '未连接');
  }, 30000);
}

main().catch(err => {
  console.error('[test] 启动失败:', err);
  process.exit(1);
});
