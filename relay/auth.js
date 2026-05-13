// relay/auth.js — 认证模块
// 提供：密码登录 + JWT 签发验证 + 登录限流
const jwt = require('jsonwebtoken');
const config = require('./config');

// 登录失败计数：Map<ip, { count, windowStart }>
const failedAttempts = new Map();

function generateToken(role, clientId) {
  return jwt.sign(
    { role, clientId, iat: Date.now() },
    config.jwtSecret,
    { expiresIn: Math.floor(config.sessionTimeout / 1000) + 's' }
  );
}

function verifyToken(token) {
  try {
    return jwt.verify(token, config.jwtSecret);
  } catch {
    return null;
  }
}

/**
 * 登录验证
 * 返回 { ok: true, token } 或 { ok: false, error }
 */
function login(password, clientIp) {
  // 1. 限流检查
  const now = Date.now();
  const record = failedAttempts.get(clientIp);

  if (record) {
    if (now - record.windowStart < config.rateLimitWindow) {
      if (record.count >= config.rateLimitLogin) {
        const retryAfter = Math.ceil((config.rateLimitWindow - (now - record.windowStart)) / 1000);
        return { ok: false, error: `尝试次数过多，请在 ${retryAfter} 秒后重试`, retryAfter };
      }
    } else {
      // 窗口过期，重置
      failedAttempts.delete(clientIp);
    }
  }

  // 2. 验证密码
  const loginPassword = process.env.LOGIN_PASSWORD;
  if (!loginPassword) {
    return { ok: false, error: '登录密码未配置' };
  }

  if (password !== loginPassword) {
    // 记录失败
    const existing = failedAttempts.get(clientIp) || { count: 0, windowStart: now };
    existing.count += 1;
    if (!failedAttempts.has(clientIp)) {
      existing.windowStart = now;
    }
    failedAttempts.set(clientIp, existing);

    const remaining = config.rateLimitLogin - existing.count;
    return { ok: false, error: `密码错误，还剩 ${remaining} 次机会` };
  }

  // 3. 成功，清除失败记录
  failedAttempts.delete(clientIp);
  const token = generateToken('client', `client_${Date.now()}`);
  return { ok: true, token };
}

/**
 * Worker 端认证
 */
function verifyWorker(secret) {
  return secret === config.workerSecret;
}

module.exports = { login, verifyToken, verifyWorker, generateToken };
