const crypto = require("node:crypto");
const { AppError, CODES } = require("./errors");

function b64url(input) {
  return Buffer.from(input).toString("base64url");
}

function sign(payloadPart, secret) {
  return crypto.createHmac("sha256", secret).update(payloadPart).digest("base64url");
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  // 先各自取摘要再比较，长度不同也不会提前返回
  const hashA = crypto.createHash("sha256").update(bufA).digest();
  const hashB = crypto.createHash("sha256").update(bufB).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

function requireSecret(config) {
  if (!config.authSecret || config.authSecret.length < 32) {
    throw new AppError(CODES.MISCONFIGURED, "服务端未配置鉴权密钥，请联系后端同事");
  }
}

function issueToken(config, username, nowMs = Date.now()) {
  requireSecret(config);
  const iat = Math.floor(nowMs / 1000);
  const payloadPart = b64url(JSON.stringify({ sub: username, iat, exp: iat + config.tokenTtlSec }));
  return `${payloadPart}.${sign(payloadPart, config.authSecret)}`;
}

function verifyToken(config, token, nowMs = Date.now()) {
  requireSecret(config);
  const [payloadPart, signature, ...rest] = String(token || "").split(".");
  if (!payloadPart || !signature || rest.length > 0) return null;
  if (!safeEqual(signature, sign(payloadPart, config.authSecret))) return null;
  try {
    const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
    if (typeof payload.exp !== "number" || payload.exp * 1000 <= nowMs) return null;
    return payload;
  } catch {
    return null;
  }
}

function login(config, username, password) {
  requireSecret(config);
  const expected = config.testAccounts.get(String(username || ""));
  // 账号不存在时也做一次比较，避免通过耗时差异探测用户名
  const ok = safeEqual(String(password || ""), expected === undefined ? "\u0000no-such-account" : expected);
  if (expected === undefined || !ok) {
    throw new AppError(CODES.LOGIN_FAILED, "账号或密码错误");
  }
  return {
    token: issueToken(config, String(username)),
    tokenType: "Bearer",
    expiresIn: config.tokenTtlSec
  };
}

function authenticate(config, authorizationHeader) {
  if (!config.authRequired) return { sub: "anonymous" };
  // 密钥没配好时报配置错误，而不是让调用方误以为是自己没登录
  requireSecret(config);
  const match = /^Bearer\s+(.+)$/i.exec(String(authorizationHeader || "").trim());
  const payload = match ? verifyToken(config, match[1]) : null;
  if (!payload) {
    throw new AppError(CODES.UNAUTHORIZED, "未登录或登录已过期，请重新登录");
  }
  return payload;
}

module.exports = { login, authenticate, issueToken, verifyToken };
