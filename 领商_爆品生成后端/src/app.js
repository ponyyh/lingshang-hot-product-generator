// HTTP 入口：路由、跨域、鉴权、入参校验、统一响应。
// 统一响应：{ code, message, data, requestId }，code === 0 为成功。
// 业务失败默认返回 HTTP 200 + 非 0 code（当前前端只在 2xx 时读取 message）；
// 设置 STRICT_HTTP_STATUS=true 后改为返回对应的 HTTP 状态码。

const crypto = require("node:crypto");
const { loadConfig } = require("./config");
const { AppError, CODES } = require("./errors");
const { login, authenticate } = require("./auth");
const { listProducts, getProductsByIds, CATALOG_SIZE } = require("./products");
const { checkTitle } = require("./compliance");
const { fetchLinkInfo, linkCacheKey } = require("./linkInfo");
const { generateTitle, newTaskId, resolveTaskId } = require("./agent");
const { buildCsv, EXPORT_FILENAME } = require("./exporter");

const MAX_BODY_BYTES = 100 * 1024;
const MAX_PRODUCT_IDS = 100;
const LINK_CACHE_TTL_MS = 10 * 60 * 1000;
// 经商品数据服务读到的结果缓存更久：每次读取都要花额度和十几秒，而商品卖点很少变
const SCRAPER_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const LINK_CACHE_MAX = 200;
const MODEL_RESERVE_MS = 5000;

// ---------- 入参校验 ----------

function badRequest(message) {
  return new AppError(CODES.BAD_REQUEST, message);
}

function parseProductIds(value) {
  if (!Array.isArray(value) || value.length === 0) throw badRequest("请先关联商品");
  if (value.length > MAX_PRODUCT_IDS) throw badRequest(`最多关联 ${MAX_PRODUCT_IDS} 件商品`);
  const ids = [];
  for (const raw of value) {
    if (!Number.isInteger(raw) || raw <= 0) throw badRequest("productIds 必须是正整数数组");
    if (!ids.includes(raw)) ids.push(raw);
  }
  const { products, missingIds } = getProductsByIds(ids);
  if (missingIds.length > 0) throw badRequest(`商品不存在：${missingIds.slice(0, 10).join("、")}`);
  return { ids, products };
}

function parseHotLink(value) {
  if (typeof value !== "string" || !value.trim()) throw badRequest("请输入爆款链接");
  const link = value.trim();
  if (link.length > 2048) throw badRequest("爆款链接过长");
  let url;
  try {
    url = new URL(link);
  } catch {
    throw badRequest("请输入以 http:// 或 https:// 开头的有效爆款链接");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw badRequest("请输入以 http:// 或 https:// 开头的有效爆款链接");
  }
  return link;
}

function parseTitle(value) {
  if (typeof value !== "string" || !value.trim()) throw badRequest("请填写标题预览");
  if (value.length > 1000) throw badRequest("标题过长");
  return value.trim();
}

function parsePositiveInt(raw, name, fallback, max) {
  if (raw === null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > max) throw badRequest(`${name} 必须是 1 到 ${max} 之间的整数`);
  return n;
}

// ---------- 请求体 ----------

function readStream(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(badRequest("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => reject(badRequest("请求体读取失败")));
  });
}

async function readJsonBody(req) {
  let raw;
  let preParsed;
  try {
    // 部分托管平台会预先解析请求体；非法 JSON 时读取 req.body 会抛错
    preParsed = req.body;
  } catch {
    throw badRequest("请求体不是合法的 JSON");
  }
  if (preParsed !== undefined && preParsed !== null) {
    if (Buffer.isBuffer(preParsed)) raw = preParsed.toString("utf8");
    else if (typeof preParsed === "string") raw = preParsed;
    else if (typeof preParsed === "object") return preParsed;
  } else {
    raw = await readStream(req);
  }
  if (Buffer.byteLength(raw || "") > MAX_BODY_BYTES) throw badRequest("请求体过大");
  if (!raw || !raw.trim()) throw badRequest("请求体不能为空");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw badRequest("请求体不是合法的 JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw badRequest("请求体必须是 JSON 对象");
  }
  return parsed;
}

// ---------- 应用 ----------

function createHandler(overrides = {}) {
  const config = overrides.config || loadConfig();
  const fetchImpl = overrides.fetchImpl || fetch;
  const linkFetcher = overrides.linkFetcher || fetchLinkInfo;
  const strictStatus = overrides.strictStatus ?? /^(1|true)$/i.test(process.env.STRICT_HTTP_STATUS || "");
  const log = overrides.log || console.log;
  const linkCache = new Map();

  async function getLinkInfo(hotLink, deadlineMs) {
    // 同一个亚马逊商品的不同链接写法（带追踪参数等）共用一份缓存
    const cacheKey = linkCacheKey(hotLink);
    const cached = linkCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.info;
    const info = await linkFetcher(hotLink, {
      timeoutMs: config.linkFetchTimeoutMs,
      scraper: config.scraper,
      // 给后面的模型调用留出时间
      scraperDeadlineMs: deadlineMs - MODEL_RESERVE_MS
    });
    // 只缓存抓取成功的结果，失败的下次重新尝试
    if (info.fetched) {
      if (linkCache.size >= LINK_CACHE_MAX) linkCache.delete(linkCache.keys().next().value);
      const ttl = info.source === "scraper" ? SCRAPER_CACHE_TTL_MS : LINK_CACHE_TTL_MS;
      linkCache.set(cacheKey, { info, expiresAt: Date.now() + ttl });
    }
    return info;
  }

  function corsHeaders(req) {
    const origin = String(req.headers.origin || "").replace(/\/$/, "");
    const headers = {
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Expose-Headers": "Content-Disposition, X-Request-Id",
      "Access-Control-Max-Age": "600"
    };
    if (config.allowedOrigins.includes("*")) {
      headers["Access-Control-Allow-Origin"] = "*";
    } else {
      headers.Vary = "Origin";
      if (origin && config.allowedOrigins.includes(origin)) headers["Access-Control-Allow-Origin"] = origin;
    }
    return headers;
  }

  async function runAgent({ body, startedAt, previousTitle }) {
    const { ids, products } = parseProductIds(body.productIds);
    const hotLink = parseHotLink(body.hotLink);
    const deadlineMs = startedAt + config.agentBudgetMs;
    const linkInfo = await getLinkInfo(hotLink, deadlineMs);
    const { title, attempts } = await generateTitle(config, {
      products,
      linkInfo,
      previousTitle,
      deadlineMs,
      fetchImpl
    });
    return { ids, linkInfo, title, attempts };
  }

  const routes = {
    "GET /api/health": {
      public: true,
      handler: () => ({
        status: "ok",
        time: new Date().toISOString(),
        authRequired: config.authRequired,
        agentConfigured: Boolean(config.ark.apiKey && config.ark.model),
        amazonDataServiceConfigured: Boolean(config.scraper.apiKey),
        productCount: CATALOG_SIZE
      })
    },

    "POST /api/auth/login": {
      public: true,
      handler: async ({ req }) => {
        const body = await readJsonBody(req);
        if (typeof body.username !== "string" || typeof body.password !== "string") {
          throw badRequest("请提供 username 和 password");
        }
        return login(config, body.username, body.password);
      }
    },

    "GET /api/products": {
      handler: ({ url }) => {
        const keyword = url.searchParams.get("keyword") || "";
        if (keyword.length > 100) throw badRequest("搜索词过长");
        return listProducts({
          keyword,
          page: parsePositiveInt(url.searchParams.get("page"), "page", 1, 100000),
          pageSize: parsePositiveInt(url.searchParams.get("pageSize"), "pageSize", 200, 200)
        });
      }
    },

    "POST /api/agent/hot-product/recognize": {
      handler: async ({ req, startedAt }) => {
        const body = await readJsonBody(req);
        const { ids, linkInfo, title, attempts } = await runAgent({ body, startedAt });
        return {
          taskId: newTaskId(),
          title,
          extractedInfo: { ...linkInfo, matchedCount: ids.length },
          attempts
        };
      }
    },

    "POST /api/agent/hot-product/regenerate-title": {
      handler: async ({ req, startedAt }) => {
        const body = await readJsonBody(req);
        const previousTitle =
          typeof body.previousTitle === "string" ? Array.from(body.previousTitle.trim()).slice(0, 300).join("") : "";
        const { title, attempts } = await runAgent({ body, startedAt, previousTitle });
        return { taskId: resolveTaskId(body.taskId), title, attempts };
      }
    },

    "POST /api/compliance/validate-title": {
      handler: async ({ req }) => {
        const body = await readJsonBody(req);
        parseProductIds(body.productIds);
        return checkTitle(parseTitle(body.title));
      }
    },

    "POST /api/hot-product/export": {
      handler: async ({ req, res, baseHeaders }) => {
        const body = await readJsonBody(req);
        const { products } = parseProductIds(body.productIds);
        const hotLink = parseHotLink(body.hotLink);
        const title = parseTitle(body.title);
        // 不信任前端已校验的结论，导出前在服务端再校验一次
        const check = checkTitle(title);
        if (!check.passed) throw new AppError(CODES.TITLE_REJECTED, check.inlineMsg);

        const csv = buildCsv({ hotLink, title, products });
        res.writeHead(200, {
          ...baseHeaders,
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Length": csv.length,
          "Content-Disposition": `attachment; filename="hot-product-plan.csv"; filename*=UTF-8''${encodeURIComponent(EXPORT_FILENAME)}`
        });
        res.end(csv);
        return undefined;
      }
    }
  };

  const knownPaths = new Set(Object.keys(routes).map((key) => key.split(" ")[1]));

  return async function handler(req, res) {
    const startedAt = Date.now();
    const requestId = crypto.randomUUID();
    const url = new URL(req.url || "/", "http://localhost");
    // 经网关重写后原始路径可能放在 __path 参数里
    const rewritten = url.searchParams.get("__path");
    const path = (rewritten || url.pathname).replace(/\/+$/, "") || "/";
    const baseHeaders = {
      ...corsHeaders(req),
      "X-Request-Id": requestId,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store"
    };

    let outcomeCode = 0;
    const sendJson = (status, code, message, data) => {
      outcomeCode = code;
      const payload = Buffer.from(JSON.stringify({ code, message, data: data ?? null, requestId }), "utf8");
      res.writeHead(status, {
        ...baseHeaders,
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": payload.length
      });
      res.end(payload);
    };

    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204, baseHeaders);
        res.end();
        return;
      }

      if (path === "/" && req.method === "GET") {
        sendJson(200, 0, "ok", { service: "领商 · 爆品生成 后端", endpoints: Object.keys(routes) });
        return;
      }

      const route = routes[`${req.method} ${path}`];
      if (!route) {
        if (knownPaths.has(path)) sendJson(405, CODES.METHOD_NOT_ALLOWED, "请求方法不支持");
        else sendJson(404, CODES.NOT_FOUND, "接口不存在");
        return;
      }

      if (!route.public) authenticate(config, req.headers.authorization);

      const data = await route.handler({ req, res, url, startedAt, baseHeaders });
      if (!res.writableEnded && !res.headersSent) sendJson(200, 0, "ok", data);
    } catch (err) {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (err instanceof AppError) {
        sendJson(strictStatus ? Math.floor(err.code / 100) : 200, err.code, err.message);
      } else {
        console.error(`[error] ${requestId}`, err);
        sendJson(strictStatus ? 500 : 200, CODES.INTERNAL, "服务器开小差了，请稍后重试");
      }
    } finally {
      log(`${req.method} ${path} code=${outcomeCode} ${Date.now() - startedAt}ms ${requestId}`);
    }
  };
}

module.exports = { createHandler };
