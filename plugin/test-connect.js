const P = require('./index');
const p = new P();
p.start({ relayUrl: 'wss://hanako.13701.top', workerSecret: 'CHVQGG7GlWrin57mOsylCWsh' });
console.log('[test] 插件已启动，连接中...');
setInterval(() => {
  console.log('[test] 状态:', p.wsClient.connected ? '在线' : '离线');
}, 10000);
