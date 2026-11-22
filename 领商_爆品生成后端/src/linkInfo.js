// 抓取爆款链接的公开页面信息（标题、描述、关键词），作为 Agent 生成标题的参考。
// 链接由用户输入，所以这里做了防 SSRF 处理：只允许 http/https 默认端口，
// 解析出的 IP 不能是内网/本机/保留地址，重定向逐跳重新校验，并限制响应大小和耗时。

const dns = require("node:dns");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");

const MAX_BYTES = 256 * 1024;
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

function requestOnce(url, deadlineMs) {
  return new Promise((resolve, reject) => {
    const remaining = deadlineMs - Date.now();
    if (remaining <= 0) return reject(new Error("抓取超时"));
    const client = url.protocol === "https:" ? https : http;
    const req = client.request(
      url,
      {
        method: "GET",
        lookup: guardedLookup,
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
          "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.6",
          "Accept-Encoding": "identity"
        }
      },
      (res) => {
        const chunks = [];
        let size = 0;
        const finish = () => {
          clearTimeout(timer);
          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            body: Buffer.concat(chunks)
          });
        };
        res.on("data", (chunk) => {
          size += chunk.length;
          chunks.push(chunk);
          if (size >= MAX_BYTES) {
            res.destroy();
            finish();
          }
        });
        res.on("end", finish);
        res.on("error", () => finish());
      }
    );
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
  [/(^|\.)(xiaohongshu|xhslink)\.com$/i, "小红书"]
];

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

// 不抛异常：抓不到时返回 fetched:false 和原因，由 Agent 仅凭商品信息生成
async function fetchLinkInfo(hotLink, { timeoutMs = 3500 } = {}) {
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
    for (let hop = 0; ; hop++) {
      assertAllowedUrl(url);
      const res = await requestOnce(url, deadlineMs);
      if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.location) {
        if (hop >= MAX_REDIRECTS) throw new Error("重定向次数过多");
        url = new URL(res.headers.location, url);
        continue;
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

module.exports = { fetchLinkInfo, parseHtml, isBlockedAddress, detectPlatform };
