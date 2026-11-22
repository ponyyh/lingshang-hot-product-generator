// 业务错误：code 为统一响应里的业务码，message 直接展示给用户
class AppError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.code = code;
    this.extra = extra;
  }
}

const CODES = {
  BAD_REQUEST: 40001,
  UNAUTHORIZED: 40101,
  LOGIN_FAILED: 40102,
  NOT_FOUND: 40401,
  METHOD_NOT_ALLOWED: 40501,
  TITLE_REJECTED: 42201,
  RATE_LIMITED: 42901,
  INTERNAL: 50001,
  MISCONFIGURED: 50002,
  AGENT_UPSTREAM: 50201,
  AGENT_NOT_CONFIGURED: 50301,
  AGENT_TIMEOUT: 50401
};

module.exports = { AppError, CODES };
