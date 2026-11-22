// 抓取爆款链接的公开页面信息（标题、描述、关键词），作为 Agent 生成标题的参考。
// 亚马逊商品页有专门的解析：商品标题、品牌、五点描述、规格表、类目。
// 链接由用户输入，所以这里做了防 SSRF 处理：只允许 http/https 默认端口，
// 解析出的 IP 不能是内网/本机/保留地址，重定向逐跳重新校验，并限制响应大小和耗时。

const dns = require("node:dns");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const zlib = require("node:zlib");

const MAX_BYTES = 256 * 1024;
// 亚马逊商品页约 1MB，标题、五点描述等信息在几十万字节之后，需要读得更多
const AMAZON_MAX_BYTES = 1536 * 1024;
// 经商品数据服务拿到的页面更大（实测 1.3 到 3.2MB，卖点在 100 万字节附近）
const SCRAPER_MAX_BYTES = 4 * 1024 * 1024;
// 读到卖点区块后再多读这么多字节就停，不必等整页传完
const AMAZON_TAIL_BYTES = 16 * 1024;
const AMAZON_BULLETS_MARKER = Buffer.from('id="feature-bullets"');
const MAX_REDIRECTS = 3;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

const blockList = new net.BlockList();
for (const [prefix, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["224.0.0.0", 4], ["240.0.0.0", 4]
]) {
  blockList.addSubnet(prefix, bits, "ipv4");
}
for (const [prefix, bits] of [
  ["::", 127], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["64:ff9b::", 96]
]) {
  blockList.addSubnet(prefix, bits, "ipv6");
}

function isBlockedAddress(address) {
  const addr = String(address).replace(/^\[|\]$/g, "");
  const family = net.isIP(addr);
  if (family === 4) return blockList.check(addr, "ipv4");
  if (family === 6) {
    // IPv4 映射地址（::ffff:10.0.0.1）按内嵌的 IPv4 判断
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(addr);
    if (mapped) return blockList.check(mapped[1], "ipv4");
    return blockList.check(addr, "ipv6");
  }
  return true;
}

// 传给 http(s).request 的 lookup：连接实际使用的就是这里校验过的地址，避免 DNS 重绑定
function guardedLookup(hostname, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    if (addresses.length === 0 || addresses.some((item) => isBlockedAddress(item.address))) {
      const blocked = new Error("目标地址不允许访问");
      blocked.code = "EBLOCKED";
      return callback(blocked);
    }
    if (options.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
}

function assertAllowedUrl(url) {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("仅支持 http/https 链接");
  if (url.username || url.password) throw new Error("链接不能包含账号信息");
  if (url.port && url.port !== "80" && url.port !== "443") throw new Error("链接端口不允许访问");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host) && isBlockedAddress(host)) throw new Error("目标地址不允许访问");
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(host)) throw new Error("目标地址不允许访问");
}

// 和真实浏览器打开页面时一致的请求头；电商站点对缺少这些头的请求更容易返回验证页
const BROWSER_HEADERS = {
  "User-Agent": USER_AGENT,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.6",
  "Accept-Encoding": "gzip, deflate, br",
  "Upgrade-Insecure-Requests": "1",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "sec-ch-ua": '"Chromium";v="130", "Google Chrome";v="130", "Not?A_Brand";v="99"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"macOS"'
};

// 按响应的压缩方式返回一个解压流；未压缩时返回 null
function createDecompressor(encoding) {
  if (/\bgzip\b/i.test(encoding)) return zlib.createGunzip();
  if (/\bdeflate\b/i.test(encoding)) return zlib.createInflate();
  if (/\bbr\b/i.test(encoding)) return zlib.createBrotliDecompress();
  return null;
}

// stopAfter：{ marker, tail }，在解压后的内容里读到 marker 后再读 tail 字节就结束，不等整页传完
function requestOnce(url, deadlineMs, maxBytes = MAX_BYTES, stopAfter = null) {
  return performRequest(url, deadlineMs, maxBytes, stopAfter, guardedLookup);
}

// 不校验目标地址，只给测试用
function requestOnceUnsafe(url, deadlineMs, maxBytes, stopAfter) {
  return performRequest(url, deadlineMs, maxBytes, stopAfter, undefined);
}

function performRequest(url, deadlineMs, maxBytes, stopAfter, lookup) {
  return new Promise((resolve, reject) => {
    const remaining = deadlineMs - Date.now();
    if (remaining <= 0) return reject(new Error("抓取超时"));
    const client = url.protocol === "https:" ? https : http;
    const req = client.request(url, { method: "GET", lookup, headers: BROWSER_HEADERS }, (res) => {
      // 压缩传输、边解压边读：跨境带宽有限时，比下载未压缩的整页快得多
      const decompressor = createDecompressor(String(res.headers["content-encoding"] || ""));
      const stream = decompressor ? res.pipe(decompressor) : res;
      const chunks = [];
      let size = 0;
      let stopAt = 0;
      let carry = Buffer.alloc(0);
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        res.destroy();
        resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks) });
      };
      stream.on("data", (chunk) => {
        if (done) return;
        size += chunk.length;
        chunks.push(chunk);
        if (stopAfter && !stopAt) {
          // 标记可能跨两个数据块，所以带上前一块的末尾一起找
          const window = Buffer.concat([carry, chunk]);
          if (window.includes(stopAfter.marker)) stopAt = size + stopAfter.tail;
          carry = window.subarray(Math.max(0, window.length - stopAfter.marker.length));
        }
        if (size >= maxBytes || (stopAt && size >= stopAt)) finish();
      });
      stream.on("end", finish);
      // 连接中断或压缩流不完整时，用已经读到的部分
      stream.on("error", finish);
      res.on("error", finish);
    });
    const timer = setTimeout(() => req.destroy(new Error("抓取超时")), remaining);
    req.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    req.end();
  });
}

function decodeBody(body, contentType) {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType || "");
  const head = body.subarray(0, 2048).toString("latin1");
  const fromMeta = /<meta[^>]+charset=["']?\s*([\w-]+)/i.exec(head);
  const charset = (fromHeader?.[1] || fromMeta?.[1] || "utf-8").toLowerCase();
  try {
    return new TextDecoder(charset).decode(body);
  } catch {
    return new TextDecoder("utf-8").decode(body);
  }
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeCodePoint(Number.parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (match, name) => ENTITIES[name.toLowerCase()] ?? match);
}

function safeCodePoint(code) {
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
}

function clean(text, maxLength) {
  const value = decodeEntities(String(text || ""))
    .replace(/<[^>]*>/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(value).slice(0, maxLength).join("");
}

function metaContent(html, key) {
  const tags = html.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const name = /\b(?:name|property)\s*=\s*["']?([^"'\s>]+)/i.exec(tag)?.[1];
    if (!name || name.toLowerCase() !== key) continue;
    const content = /\bcontent\s*=\s*"([^"]*)"/i.exec(tag) || /\bcontent\s*=\s*'([^']*)'/i.exec(tag);
    if (content) return content[1];
  }
  return "";
}

function parseHtml(html) {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || "";
  return {
    pageTitle: clean(metaContent(html, "og:title") || title, 200),
    description: clean(metaContent(html, "og:description") || metaContent(html, "description"), 300),
    keywords: clean(metaContent(html, "keywords"), 200)
  };
}

const PLATFORMS = [
  [/(^|\.)(taobao|tmall)\.com$/i, "淘宝/天猫"],
  [/(^|\.)jd\.com$/i, "京东"],
  [/(^|\.)(pinduoduo|yangkeduo)\.com$/i, "拼多多"],
  [/(^|\.)(douyin|jinritemai)\.com$/i, "抖音电商"],
  [/(^|\.)1688\.com$/i, "1688"],
  [/(^|\.)(xiaohongshu|xhslink)\.com$/i, "小红书"],
  [/(^|\.)amazon\.(com|[a-z]{2}|com?\.[a-z]{2})$/i, "亚马逊"],
  [/^(a\.co|amzn\.(to|asia|eu|com))$/i, "亚马逊"]
];

function isAmazonHost(hostname) {
  return detectPlatform(hostname) === "亚马逊";
}

// 从亚马逊链接里取出 10 位商品编号（ASIN），取不到返回空串
function extractAsin(url) {
  const match = /\/(?:dp|gp\/product|gp\/aw\/d|product-reviews)\/([A-Z0-9]{10})(?:[/?]|$)/i.exec(url.pathname);
  return match ? match[1].toUpperCase() : "";
}

// 亚马逊商品链接常带很长的标题路径和追踪参数，统一成 /dp/ASIN 再请求，结果更稳定
function canonicalAmazonUrl(url) {
  const asin = extractAsin(url);
  return asin ? new URL(`${url.protocol}//${url.hostname}/dp/${asin}`) : url;
}

function sectionAfter(html, marker, length) {
  const index = html.indexOf(marker);
  return index === -1 ? "" : html.slice(index, index + length);
}

// 解析亚马逊商品页：商品标题、品牌、五点描述、规格表、类目
function parseAmazonHtml(html) {
  const title = clean(/id="productTitle"[^>]*>([\s\S]*?)<\/span>/i.exec(html)?.[1], 300);

  const bullets = [];
  const bulletSection = sectionAfter(html, 'id="feature-bullets"', 12000);
  for (const match of bulletSection.matchAll(/<span class="a-list-item[^"]*">([\s\S]*?)<\/span>/gi)) {
    const text = clean(match[1], 220);
    if (text && bullets.length < 6) bullets.push(text);
  }

  const attributes = [];
  const overview = sectionAfter(html, 'id="productOverview_feature_div"', 8000);
  for (const row of overview.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((cell) => clean(cell[1], 80));
    if (cells.length >= 2 && cells[0] && cells[1] && attributes.length < 8) {
      attributes.push({ name: cells[0], value: cells[1] });
    }
  }

  const byline = clean(/id="bylineInfo"[^>]*>([\s\S]*?)<\/a>/i.exec(html)?.[1], 80);
  const brand =
    attributes.find((item) => /^(brand|品牌)/i.test(item.name))?.value ||
    byline.replace(/^(visit the|brand:|访问|品牌[:：]?)\s*/i, "").replace(/\s*(store|品牌旗舰店|旗舰店|商店)$/i, "");

  // 网页标题形如 "Amazon.com: 商品标题 : 类目"，最后一段是类目
  const pageTitle = clean(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1], 500);
  const titleParts = pageTitle.split(/\s[:：]\s/);
  // 部分站点（如英国站）的最后一段是 "Amazon.co.uk: 类目"，去掉站点名前缀
  const category =
    titleParts.length >= 2
      ? clean(titleParts[titleParts.length - 1].replace(/^Amazon\.[a-z.]+\s*[:：]\s*/i, ""), 60)
      : "";

  return { title, brand: clean(brand, 60), bullets, attributes, category };
}

function isAmazonBlocked(res) {
  if (res.status === 503 || res.status === 429 || res.status === 403) return true;
  // 验证页很小；正常商品页有几十万字节，不必对整页做匹配
  return res.body.length < 60000 && AMAZON_BLOCK_PATTERN.test(res.body.toString("latin1"));
}

// 亚马逊的反爬页面：机器人校验、验证码
const AMAZON_BLOCK_PATTERN = /api-services-support@amazon\.com|\/errors\/validateCaptcha|Enter the characters you see below|Type the characters you see in this image|请输入您在下方看到的字符|opfcaptcha|Click the button below to continue shopping/i;


function detectPlatform(hostname) {
  return PLATFORMS.find(([pattern]) => pattern.test(hostname))?.[1] || "";
}

// 登录页、验证码页的标题不是商品信息，不能拿去生成标题
const WALL_PATTERN = /登录|登陆|login|sign in|验证|captcha|访问受限|访问被拒|403 forbidden|access denied/i;

// 抛给调用方的原因只用固定文案，底层网络错误详情不外露
function describeFetchError(err) {
  const message = String(err?.message || "");
  if (/[\u4e00-\u9fa5]/.test(message)) return message;
  if (err?.code === "ENOTFOUND" || err?.code === "EAI_AGAIN") return "域名无法解析";
  if (err?.code === "ERR_INVALID_URL") return "链接格式不正确";
  return "网络连接失败";
}

// 某个亚马逊站点直连被拦截后，这段时间内不再重复尝试直连，直接走商品数据服务
const DIRECT_BLOCK_MEMO_MS = 10 * 60 * 1000;
const directBlockedUntil = new Map();

// 通过第三方商品数据服务（ScraperAPI）读取页面：它用自己的出口 IP 访问并处理验证页，返回页面原文。
// 返回 { res } 或 { note }；note 是给用户看的失败原因，不包含密钥和上游详情。
async function fetchViaScraper(target, scraper, deadlineLimitMs, requestImpl) {
  const api = new URL(scraper.baseUrl);
  api.searchParams.set("api_key", scraper.apiKey);
  // 美国站指定美国出口，返回的才是美国站的内容和语言
  if (/(^|\.)amazon\.com$/i.test(target.hostname)) api.searchParams.set("country_code", "us");
  api.searchParams.set("url", target.href);
  const deadlineMs = Math.min(Date.now() + scraper.timeoutMs, deadlineLimitMs || Infinity);
  let res;
  try {
    assertAllowedUrl(api);
    res = await requestImpl(api, deadlineMs, SCRAPER_MAX_BYTES, {
      marker: AMAZON_BULLETS_MARKER,
      tail: AMAZON_TAIL_BYTES
    });
  } catch (err) {
    console.warn(`[link] 商品数据服务请求失败 target=${target.hostname} reason=${err.code || err.message}`);
    return {
      note: /超时/.test(String(err.message)) ? "商品数据服务读取超时，请稍后重试" : "商品数据服务连接失败，请稍后重试"
    };
  }
  if (res.status === 404) return { res };
  if (res.status >= 200 && res.status < 300) return { res };
  console.warn(`[link] 商品数据服务返回 HTTP ${res.status} target=${target.hostname}`);
  if (res.status === 401 || res.status === 403) return { note: "商品数据服务的密钥无效或额度不足，请联系后端同事" };
  if (res.status === 429) return { note: "商品数据服务请求过于频繁，请稍后重试" };
  return { note: `商品数据服务暂时不可用（HTTP ${res.status}），请稍后重试` };
}

// 不抛异常：抓不到时返回 fetched:false 和原因，由 Agent 仅凭商品信息生成。
// scraper：{ apiKey, baseUrl, timeoutMs, always }，配置后亚马逊直连被拦截时改走商品数据服务。
async function fetchLinkInfo(
  hotLink,
  { timeoutMs = 3500, scraper = null, scraperDeadlineMs = 0, requestImpl = requestOnce } = {}
) {
  const info = {
    sourceUrl: hotLink,
    host: "",
    platform: "",
    fetched: false,
    pageTitle: "",
    description: "",
    keywords: "",
    note: ""
  };
  const deadlineMs = Date.now() + timeoutMs;
  try {
    let url = new URL(hotLink);
    const originalPath = url.pathname;
    info.host = url.hostname;
    info.platform = detectPlatform(url.hostname);
    if (isAmazonHost(url.hostname)) url = canonicalAmazonUrl(url);
    for (let hop = 0; ; hop++) {
      assertAllowedUrl(url);
      const amazon = isAmazonHost(url.hostname);
      const canUseScraper = amazon && Boolean(scraper?.apiKey);
      const skipDirect =
        canUseScraper && (scraper.always || (directBlockedUntil.get(url.hostname) || 0) > Date.now());
      let res = null;
      if (!skipDirect) {
        try {
          res = await requestImpl(url, deadlineMs, amazon ? AMAZON_MAX_BYTES : MAX_BYTES);
        } catch (err) {
          // 服务器连不上这个亚马逊站点（如网络不通、超时）时，有商品数据服务就改走它
          if (!canUseScraper) throw err;
          console.warn(`[link] 亚马逊直连失败 host=${url.hostname} reason=${err.code || err.message}`);
        }
      }
      if (amazon && (!res || isAmazonBlocked(res))) {
        directBlockedUntil.set(url.hostname, Date.now() + DIRECT_BLOCK_MEMO_MS);
      }
      if (canUseScraper && (!res || isAmazonBlocked(res))) {
        const outcome = await fetchViaScraper(url, scraper, scraperDeadlineMs, requestImpl);
        if (outcome.note) {
          info.platform = "亚马逊";
          info.note = outcome.note;
          return info;
        }
        res = outcome.res;
        info.source = "scraper";
      }
      if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.location) {
        if (hop >= MAX_REDIRECTS) throw new Error("重定向次数过多");
        url = new URL(res.headers.location, url);
        // 短链接（a.co、amzn.to）跳转到商品页后，同样统一成 /dp/ASIN
        if (isAmazonHost(url.hostname)) url = canonicalAmazonUrl(url);
        continue;
      }
      if (amazon) {
        info.platform = "亚马逊";
        if (res.status === 404) {
          info.note = "亚马逊上找不到这个商品，请检查链接是否完整";
          return info;
        }
        if (isAmazonBlocked(res)) {
          console.warn(`[link] 亚马逊拒绝读取 host=${url.hostname} status=${res.status} bytes=${res.body.length}`);
          info.note = "亚马逊暂时拒绝了读取请求（触发了访问验证），请稍后重试";
          return info;
        }
        if (res.status < 200 || res.status >= 300) throw new Error(`页面返回 HTTP ${res.status}`);
        const product = parseAmazonHtml(decodeBody(res.body, String(res.headers["content-type"] || "")));
        if (!product.title) {
          info.note = extractAsin(url)
            ? "未能从亚马逊页面读取到商品标题"
            : "这不是亚马逊商品详情页链接，请使用包含 /dp/ 的商品链接";
          return info;
        }
        Object.assign(info, {
          fetched: true,
          asin: extractAsin(url),
          pageTitle: product.title,
          description: product.bullets.join("；").slice(0, 600),
          keywords: product.attributes.map((item) => `${item.name}:${item.value}`).join("，").slice(0, 300),
          brand: product.brand,
          category: product.category,
          bullets: product.bullets,
          attributes: product.attributes
        });
        return info;
      }
      if (res.status < 200 || res.status >= 300) throw new Error(`页面返回 HTTP ${res.status}`);
      const contentType = String(res.headers["content-type"] || "");
      if (contentType && !/html|text\/plain/i.test(contentType)) throw new Error("链接不是网页");
      const parsed = parseHtml(decodeBody(res.body, contentType));
      if (/login|passport|captcha/i.test(url.hostname + url.pathname) || WALL_PATTERN.test(parsed.pageTitle)) {
        info.note = "该链接需要登录或验证后才能查看，未能读取商品信息";
        return info;
      }
      // 商品已下架或需要登录时，电商站点常把请求重定向到首页，首页标题不是商品信息
      if (hop > 0 && url.pathname.replace(/\/+$/, "") === "" && originalPath.replace(/\/+$/, "") !== "") {
        info.note = "该链接跳转到了站点首页，未能读取商品信息";
        return info;
      }
      if (!parsed.pageTitle && !parsed.description) {
        info.note = "页面未提供可读取的标题或描述";
        return info;
      }
      Object.assign(info, parsed, { fetched: true });
      return info;
    }
  } catch (err) {
    info.note = `未能读取链接内容：${describeFetchError(err)}`;
    return info;
  }
}

// 缓存用的键：亚马逊商品链接统一成 站点 + 商品编号，其他链接用原文
function linkCacheKey(hotLink) {
  try {
    const url = new URL(hotLink);
    const asin = isAmazonHost(url.hostname) ? extractAsin(url) : "";
    return asin ? `amazon:${url.hostname.replace(/^www\./i, "").toLowerCase()}:${asin}` : hotLink;
  } catch {
    return hotLink;
  }
}

module.exports = {
  fetchLinkInfo,
  linkCacheKey,
  // 仅供测试直接验证底层读取行为；它不做地址安全校验，业务代码不要使用
  requestForTest: requestOnceUnsafe,
  parseHtml,
  parseAmazonHtml,
  extractAsin,
  canonicalAmazonUrl,
  isBlockedAddress,
  detectPlatform
};
