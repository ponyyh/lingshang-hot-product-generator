function bool(value, fallback) {
  if (value === undefined || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

function int(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseAccounts(raw) {
  const accounts = new Map();
  for (const pair of String(raw || "").split(",")) {
    const idx = pair.indexOf(":");
    if (idx <= 0) continue;
    const username = pair.slice(0, idx).trim();
    const password = pair.slice(idx + 1).trim();
    if (username && password) accounts.set(username, password);
  }
  return accounts;
}

function loadConfig(env = process.env) {
  return {
    allowedOrigins: String(env.ALLOWED_ORIGINS || "*")
      .split(",")
      .map((s) => s.trim().replace(/\/$/, ""))
      .filter(Boolean),
    // 默认开启鉴权：漏配环境变量时宁可拒绝请求，也不把付费的 Agent 接口裸露出去
    authRequired: bool(env.AUTH_REQUIRED, true),
    authSecret: String(env.AUTH_SECRET || ""),
    testAccounts: parseAccounts(env.TEST_ACCOUNTS),
    tokenTtlSec: int(env.TOKEN_TTL_SECONDS, 86400),
    ark: {
      baseUrl: String(env.ARK_BASE_URL || "https://ark.cn-beijing.volces.com/api/v3").replace(/\/$/, ""),
      apiKey: String(env.ARK_API_KEY || ""),
      model: String(env.ARK_MODEL || ""),
      disableThinking: bool(env.ARK_DISABLE_THINKING, false)
    },
    agentBudgetMs: int(env.AGENT_BUDGET_MS, 13000),
    llmTimeoutMs: int(env.LLM_TIMEOUT_MS, 10000),
    linkFetchTimeoutMs: int(env.LINK_FETCH_TIMEOUT_MS, 3500)
  };
}

module.exports = { loadConfig };
