// relay/config.js — 环境变量配置
// 所有配置集中读取，模块启动时自动加载

const ENV = process.env;

const config = {
  // 服务端口
  port: parseInt(ENV.PORT, 10) || 3000,

  // JWT
  jwtSecret: ENV.JWT_SECRET || 'dev-secret-change-in-production',
  sessionTimeout: parseInt(ENV.SESSION_TIMEOUT, 10) || 1800000, // 30 分钟

  // Worker 认证
  workerSecret: ENV.WORKER_SECRET || 'worker-secret-change-in-production',

  // 登录限流
  rateLimitLogin: parseInt(ENV.RATE_LIMIT_LOGIN, 10) || 5,
  rateLimitWindow: parseInt(ENV.RATE_LIMIT_WINDOW, 10) || 900000, // 15 分钟

  // 心跳
  heartbeatInterval: parseInt(ENV.HEARTBEAT_INTERVAL, 10) || 15000, // 15s
  heartbeatTimeout: parseInt(ENV.HEARTBEAT_TIMEOUT, 10) || 30000,   // 30s

  // 静态文件目录
  staticDir: ENV.STATIC_DIR || 'public',
};

module.exports = config;
