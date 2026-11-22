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
    // 第三方商品数据服务（ScraperAPI）：亚马逊直连被拦截时用它读取商品页
    scraper: {
      apiKey: String(env.SCRAPER_API_KEY || ""),
      baseUrl: String(env.SCRAPER_API_URL || "https://api.scraperapi.com/"),
      timeoutMs: int(env.SCRAPER_TIMEOUT_MS, 20000),
      always: bool(env.SCRAPER_ALWAYS, false)
    },
    // 走商品数据服务时一次读取可能要十几秒，所以总预算比前端 30 秒超时略短
    agentBudgetMs: int(env.AGENT_BUDGET_MS, 27000),
    llmTimeoutMs: int(env.LLM_TIMEOUT_MS, 10000),
    // 亚马逊商品页约 1MB，实测读取要 2 到 3 秒，留出余量
    linkFetchTimeoutMs: int(env.LINK_FETCH_TIMEOUT_MS, 6000)
  };
}

module.exports = { loadConfig };
