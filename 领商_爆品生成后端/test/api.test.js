const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { createHandler } = require("../src/app");
const { loadConfig } = require("../src/config");
const { isBlockedAddress, parseHtml, fetchLinkInfo } = require("../src/linkInfo");
const { cleanTitle } = require("../src/agent");
const { readXlsx, buildXlsx } = require("../src/xlsx");

const SECRET = "x".repeat(40);
const GOOD = "液态硅胶波漾纹手机壳 适用iPhone 18 Pro 亲肤防滑全包镜头保护壳";

function modelFetch(replies, calls = []) {
  let i = 0;
  return async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization });
    const reply = replies[Math.min(i++, replies.length - 1)];
    if (reply instanceof Error) throw reply;
    if (typeof reply === "number") return new Response("upstream secret detail", { status: reply });
    return Response.json({ choices: [{ message: { content: reply } }] });
  };
}

async function start(opts = {}) {
  const config = loadConfig({
    AUTH_SECRET: SECRET, TEST_ACCOUNTS: "tester:pass123", ARK_API_KEY: "k", ARK_MODEL: "m",
    ALLOWED_ORIGINS: opts.origins || "*", ...(opts.env || {})
  });
  const handler = createHandler({
    config, log: () => {}, strictStatus: opts.strict || false,
    fetchImpl: opts.fetchImpl || modelFetch([GOOD]),
    linkFetcher: opts.linkFetcher || (async (u) => ({ sourceUrl: u, host: "x.com", platform: "", fetched: true, pageTitle: "爆款手机壳", description: "", keywords: "", note: "" }))
  });
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, { body, token, headers = {}, raw } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined
    });
    const isJson = (res.headers.get("content-type") || "").includes("json");
    return { status: res.status, headers: res.headers, json: isJson ? await res.json() : null, buf: isJson ? null : Buffer.from(await res.arrayBuffer()) };
  };
  const login = async () => (await call("POST", "/api/auth/login", { body: { username: "tester", password: "pass123" } })).json.data.token;
  // 断言失败时 close 不会被调用，unref 保证遗留的服务不会让测试进程挂住
  server.unref();
  return { call, login, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
}

test("health 公开；其余接口无令牌返回 40101", async () => {
  const s = await start();
  const h = await s.call("GET", "/api/health");
  assert.equal(h.json.code, 0);
  assert.equal(h.json.data.agentConfigured, true);
  for (const [m, p] of [["GET", "/api/products"], ["POST", "/api/agent/hot-product/recognize"], ["POST", "/api/compliance/validate-title"], ["POST", "/api/hot-product/export"]]) {
    const r = await s.call(m, p, m === "POST" ? { body: {} } : {});
    assert.equal(r.json.code, 40101, p);
  }
  assert.equal((await s.call("GET", "/api/products", { token: "bad.token" })).json.code, 40101);
  await s.close();
});

test("登录：错误密码与未知账号都返回 40102；过期令牌被拒", async () => {
  const s = await start({ env: { TOKEN_TTL_SECONDS: "1" } });
  assert.equal((await s.call("POST", "/api/auth/login", { body: { username: "tester", password: "nope" } })).json.code, 40102);
  assert.equal((await s.call("POST", "/api/auth/login", { body: { username: "ghost", password: "pass123" } })).json.code, 40102);
  const token = await s.login();
  assert.equal((await s.call("GET", "/api/products", { token })).json.code, 0);
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal((await s.call("GET", "/api/products", { token })).json.code, 40101);
  await s.close();
});

test("未配置 AUTH_SECRET 时拒绝服务而不是放行", async () => {
  const s = await start({ env: { AUTH_SECRET: "" } });
  assert.equal((await s.call("GET", "/api/products")).json.code, 50002);
  assert.equal((await s.call("POST", "/api/auth/login", { body: { username: "tester", password: "pass123" } })).json.code, 50002);
  await s.close();
});

test("商品列表：字段与商品表一致，分页、搜索、空结果、非法参数", async () => {
  const s = await start(); const token = await s.login();
  const all = (await s.call("GET", "/api/products", { token })).json.data;
  assert.equal(all.total, 2); assert.equal(all.list.length, 2);
  assert.deepEqual(Object.keys(all.list[0]), ["id", "title", "variantName", "color", "model", "skuCode", "declaredPrice", "weight", "packagingShape", "packagingType", "previewImage"]);
  assert.deepEqual(
    [all.list[0].title, all.list[0].variantName, all.list[0].skuCode, all.list[0].declaredPrice, all.list[0].weight, all.list[0].packagingShape, all.list[0].packagingType],
    ["Phone Case for Samsung S26", "粉红色，Galaxy S26", "GDK-Galaxy S26-Pink-YXG134", "18.0", "42.0", "长方体", "软包装+软物"]
  );
  assert.match(all.list[1].previewImage, /^https:\/\/img\.cdnfe\.com\//);
  // 内部用的属性、整行数据不对外返回
  assert.ok(!("attributes" in all.list[0]) && !("row" in all.list[0]) && !("category" in all.list[0]));
  const page = (await s.call("GET", "/api/products?page=2&pageSize=1", { token })).json.data;
  assert.equal(page.list[0].id, 2); assert.equal(page.list.length, 1);
  const kw = (await s.call("GET", "/api/products?keyword=" + encodeURIComponent("iphone 18"), { token })).json.data;
  assert.deepEqual(kw.list.map((p) => p.id), [2]);
  assert.deepEqual((await s.call("GET", "/api/products?keyword=YXG134", { token })).json.data.list.map((p) => p.id), [1]);
  assert.deepEqual((await s.call("GET", "/api/products?keyword=" + encodeURIComponent("粉红色"), { token })).json.data.list.map((p) => p.id), [1]);
  const empty = (await s.call("GET", "/api/products?keyword=zzzz", { token })).json.data;
  assert.deepEqual([empty.total, empty.list], [0, []]);
  assert.equal((await s.call("GET", "/api/products?pageSize=0", { token })).json.code, 40001);
  assert.equal((await s.call("GET", "/api/products?page=abc", { token })).json.code, 40001);
  await s.close();
});

test("识别：成功返回 taskId/title/extractedInfo，密钥只发给模型服务", async () => {
  const calls = []; const s = await start({ fetchImpl: modelFetch([`标题：“${GOOD}”\n说明：xxx`], calls) }); const token = await s.login();
  const r = await s.call("POST", "/api/agent/hot-product/recognize", { token, body: { productIds: [1, 2, 2], hotLink: "https://x.com/item" } });
  assert.equal(r.json.code, 0);
  assert.match(r.json.data.taskId, /^task_\d{8}_[0-9a-f]{8}$/);
  assert.equal(r.json.data.title, GOOD);
  assert.equal(r.json.data.extractedInfo.matchedCount, 2);
  assert.equal(calls.length, 1); assert.equal(calls[0].auth, "Bearer k");
  assert.match(calls[0].body.messages[1].content, /适用机型：Galaxy S26、iPhone 18 Pro/);
  assert.match(calls[0].body.messages[1].content, /颜色：粉红色、混合色1/);
  // 商品表里的材质、工艺交给模型；「是否带支架=否」这类否定属性不交
  assert.match(calls[0].body.messages[1].content, /主要材质=TPU\/PC/);
  assert.match(calls[0].body.messages[1].content, /印花工艺=UV打印\/热转印/);
  assert.ok(!calls[0].body.messages[1].content.includes("是否带支架"));
  assert.match(calls[0].body.messages[1].content, /爆款手机壳/);
  await s.close();
});

test("识别：入参错误逐项提示", async () => {
  const s = await start(); const token = await s.login(); const p = "/api/agent/hot-product/recognize";
  const msg = async (body) => (await s.call("POST", p, { token, body })).json;
  assert.equal((await msg({ productIds: [], hotLink: "https://x.com" })).message, "请先关联商品");
  assert.equal((await msg({ productIds: [1], hotLink: "" })).message, "请输入爆款链接");
  assert.match((await msg({ productIds: [1], hotLink: "ftp://x.com" })).message, /http/);
  assert.match((await msg({ productIds: [1, 9999], hotLink: "https://x.com" })).message, /商品不存在：9999/);
  assert.equal((await msg({ productIds: ["1"], hotLink: "https://x.com" })).code, 40001);
  assert.equal((await msg({ productIds: Array.from({ length: 101 }, (_, i) => i + 1), hotLink: "https://x.com" })).code, 40001);
  assert.equal((await s.call("POST", p, { token, raw: "{bad", headers: { "Content-Type": "application/json" } })).json.message, "请求体不是合法的 JSON");
  assert.equal((await s.call("POST", p, { token, raw: "[1]", headers: { "Content-Type": "application/json" } })).json.code, 40001);
  await s.close();
});

test("Agent：首版含极限词时带原因重试；两次都违规则删词兜底", async () => {
  const calls = []; let s = await start({ fetchImpl: modelFetch(["全网最低 顶级硅胶手机壳 适用iPhone 18 Pro", GOOD], calls) }); let token = await s.login();
  let r = await s.call("POST", "/api/agent/hot-product/recognize", { token, body: { productIds: [1], hotLink: "https://x.com" } });
  assert.equal(r.json.data.title, GOOD); assert.equal(r.json.data.attempts, 2);
  assert.match(calls[1].body.messages[1].content, /上一次输出的问题/);
  await s.close();
  s = await start({ fetchImpl: modelFetch(["顶级液态硅胶手机壳 适用iPhone 18 Pro 防摔保护套"]) }); token = await s.login();
  r = await s.call("POST", "/api/agent/hot-product/recognize", { token, body: { productIds: [1], hotLink: "https://x.com" } });
  assert.equal(r.json.code, 0); assert.ok(!r.json.data.title.includes("顶级"));
  await s.close();
});

test("Agent：上游失败、限流、超时、未配置都给出明确提示且不泄露上游详情", async () => {
  const body = { productIds: [1], hotLink: "https://x.com" }; const p = "/api/agent/hot-product/recognize";
  const run = async (opts) => { const s = await start(opts); const token = await s.login(); const r = await s.call("POST", p, { token, body }); await s.close(); return r; };
  let r = await run({ fetchImpl: modelFetch([500]) });
  assert.equal(r.json.code, 50201); assert.ok(!JSON.stringify(r.json).includes("upstream secret"));
  assert.equal((await run({ fetchImpl: modelFetch([429]) })).json.code, 42901);
  const timeout = Object.assign(new Error("t"), { name: "TimeoutError" });
  r = await run({ fetchImpl: modelFetch([timeout]) });
  assert.equal(r.json.code, 50401); assert.equal(r.json.message, "AI 生成超时，请稍后重试");
  assert.equal((await run({ env: { ARK_API_KEY: "" } })).json.code, 50301);
  assert.equal((await run({ fetchImpl: modelFetch([""]) })).json.code, 50201);
  r = await run({ fetchImpl: modelFetch([500]), strict: true });
  assert.equal(r.status, 502);
});

test("重新生成：沿用 taskId，把上一版标题传给模型；链接读不到也能生成", async () => {
  const calls = [];
  const s = await start({ fetchImpl: modelFetch([GOOD], calls), linkFetcher: async (u) => ({ sourceUrl: u, host: "", platform: "淘宝/天猫", fetched: false, pageTitle: "", description: "", keywords: "", note: "需要登录" }) });
  const token = await s.login();
  const r = await s.call("POST", "/api/agent/hot-product/regenerate-title", { token, body: { taskId: "task_20261122_abc", productIds: [1], hotLink: "https://qn.taobao.com/x", previousTitle: "旧标题旧标题" } });
  assert.equal(r.json.data.taskId, "task_20261122_abc");
  assert.match(calls[0].body.messages[1].content, /旧标题旧标题/);
  assert.match(calls[0].body.messages[1].content, /未能读取到该链接/);
  const r2 = await s.call("POST", "/api/agent/hot-product/regenerate-title", { token, body: { taskId: null, productIds: [1], hotLink: "https://qn.taobao.com/x" } });
  assert.match(r2.json.data.taskId, /^task_/);
  await s.close();
});

test("标题校验：通过、敏感词、极限词、长度、绕过写法", async () => {
  const s = await start(); const token = await s.login();
  const v = async (title) => (await s.call("POST", "/api/compliance/validate-title", { token, body: { title, productIds: [1] } })).json;
  assert.deepEqual((await v(GOOD)).data, { passed: true });
  let d = (await v("血腥暴力风格手机壳 适用iPhone 18 Pro")).data;
  assert.deepEqual([d.passed, d.violationType, d.category], [false, "sensitive", "血腥暴力与犯罪"]);
  assert.match(d.inlineMsg, /血腥暴力与犯罪/);
  d = (await v("全网第一硅胶手机壳 适用iPhone 18 Pro")).data;
  assert.deepEqual([d.violationType, d.toastMsg], ["platform", "下载失败"]);
  assert.equal((await v("太短了")).data.category, "标题长度");
  assert.equal((await v("赌 博　专用手机壳适用iPhone十八")).data.category, "涉赌违法");
  assert.equal((await v("ｋ粉同款白色手机壳适用iPhone")).data.category, "涉毒违禁");
  assert.equal((await v("")).message, "请填写标题预览");
  assert.equal((await s.call("POST", "/api/compliance/validate-title", { token, body: { title: GOOD, productIds: [] } })).json.code, 40001);
  await s.close();
});

test("导出：返回与商品表格式一致的 xlsx，只改产品标题、来源URL、更新时间三列", async () => {
  const s = await start(); const token = await s.login();
  const hotLink = "https://x.com/a?b=1,2&c=<3>";
  const ok = await s.call("POST", "/api/hot-product/export", { token, body: { taskId: "t", productIds: [2, 1], hotLink, title: GOOD } });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("content-type"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  assert.equal(ok.headers.get("content-disposition"), 'attachment; filename="product_list.xlsx"');
  assert.deepEqual([...ok.buf.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04]);

  const { sheetName, rows } = readXlsx(ok.buf);
  const source = JSON.parse(fs.readFileSync(path.join(__dirname, "../src/data/products.json"), "utf8"));
  assert.equal(sheetName, "pddkj_product");
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], source.columns);
  assert.equal(rows[0].length, 69);
  const col = (name) => rows[0].indexOf(name);
  // 行的顺序与请求里的 productIds 一致
  assert.equal(rows[1][col("SKU货号")], "FLJK-iPhone 18 Pro-White-YXFL031");
  assert.equal(rows[2][col("SKU货号")], "GDK-Galaxy S26-Pink-YXG134");
  for (const [exported, original] of [[rows[1], source.rows[1]], [rows[2], source.rows[0]]]) {
    assert.equal(exported.length, 69);
    assert.equal(exported[col("产品标题")], GOOD);
    assert.equal(exported[col("来源URL")], hotLink);
    assert.match(exported[col("更新时间")], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    const changed = rows[0].filter((name, i) => exported[i] !== original[i]);
    assert.deepEqual(changed, ["产品标题", "来源URL", "更新时间"]);
  }
  // 多行内容（轮播图的多个地址）和 JSON 属性原样保留
  assert.equal(rows[2][col("轮播图")].split("\n").length, source.rows[0][col("轮播图")].split("\n").length);
  assert.deepEqual(JSON.parse(rows[2][col("产品属性")]), JSON.parse(source.rows[0][col("产品属性")]));

  const bad = await s.call("POST", "/api/hot-product/export", { token, body: { productIds: [1], hotLink: "https://x.com", title: "顶级硅胶手机壳 适用iPhone 18 Pro" } });
  assert.equal(bad.json.code, 42201); assert.match(bad.json.message, /顶级/);
  assert.equal((await s.call("POST", "/api/hot-product/export", { token, body: { productIds: [99], hotLink: "https://x.com", title: GOOD } })).json.message, "商品不存在：99");
  await s.close();
});

test("xlsx 读写：特殊字符、换行、首尾空白、公式样文本都按文本原样往返；文件结构与商品表一致", () => {
  const header = ["A列", "B<列>", "C&列"];
  const tricky = ["=HYPERLINK(\"http://x\")", "  首尾空白  ", "多行\n内容\r\n第三行"];
  const odd = ["emoji 📱 中文", "引号\"'<>&", "控制\u0001字符"];
  const file = buildXlsx({ sheetName: "pddkj_product", header, rows: [tricky, odd, ["只有一格"]], createdAt: new Date("2026-11-22T00:00:00Z") });
  const { sheetName, rows } = readXlsx(file);
  assert.equal(sheetName, "pddkj_product");
  assert.deepEqual(rows[0], header);
  assert.deepEqual(rows[1], ["=HYPERLINK(\"http://x\")", "  首尾空白  ", "多行\n内容\n第三行"]);
  assert.deepEqual(rows[2], ["emoji 📱 中文", "引号\"'<>&", "控制字符"]);
  assert.deepEqual(rows[3], ["只有一格", "", ""]);
  // 所有单元格都是文本类型，公式样的内容不会被当成公式
  const { unzip } = require("../src/xlsx");
  const sheet = unzip(file).get("xl/worksheets/sheet1.xml").toString("utf8");
  assert.equal((sheet.match(/<c /g) || []).length, 12);
  assert.equal((sheet.match(/t="inlineStr"/g) || []).length, 12);
  assert.ok(!sheet.includes("<f>"));
  assert.match(sheet, /<row r="1" customHeight="true" ht="42.5">/);
  assert.match(sheet, /<dimension ref="A1:C4"\/>/);
  assert.deepEqual([...unzip(file).keys()].sort(), ["[Content_Types].xml", "_rels/.rels", "docProps/app.xml", "docProps/core.xml", "xl/_rels/workbook.xml.rels", "xl/sharedStrings.xml", "xl/styles.xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml"]);
  assert.throws(() => readXlsx(Buffer.from("not a zip file at all")), /不是有效的 xlsx/);
});

test("跨域：预检放行；白名单模式只回显允许的来源", async () => {
  let s = await start();
  let r = await s.call("OPTIONS", "/api/products", { headers: { Origin: "https://a.com", "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization,content-type" } });
  assert.equal(r.status, 204);
  assert.equal(r.headers.get("access-control-allow-origin"), "*");
  assert.match(r.headers.get("access-control-allow-headers"), /Authorization/);
  await s.close();
  s = await start({ origins: "https://front.example.com" });
  r = await s.call("GET", "/api/health", { headers: { Origin: "https://front.example.com" } });
  assert.equal(r.headers.get("access-control-allow-origin"), "https://front.example.com");
  r = await s.call("GET", "/api/health", { headers: { Origin: "https://evil.example.com" } });
  assert.equal(r.headers.get("access-control-allow-origin"), null);
  await s.close();
});

test("路由：未知路径 404、方法不对 405、重写参数", async () => {
  const s = await start(); const token = await s.login();
  let r = await s.call("GET", "/api/nope"); assert.deepEqual([r.status, r.json.code], [404, 40401]);
  r = await s.call("GET", "/api/hot-product/export"); assert.deepEqual([r.status, r.json.code], [405, 40501]);
  r = await s.call("GET", "/api?__path=/api/products&pageSize=1", { token });
  assert.equal(r.json.data.list.length, 1);
  assert.ok(r.json.requestId && r.headers.get("x-request-id") === r.json.requestId);
  await s.close();
});

test("链接抓取：拦截内网地址，解析网页信息，清洗模型输出", async () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.1.4", "169.254.169.254", "172.16.0.1", "::1", "fe80::1", "::ffff:10.0.0.1", "0.0.0.0", "100.64.0.1"]) assert.equal(isBlockedAddress(ip), true, ip);
  for (const ip of ["8.8.8.8", "101.126.13.31", "2606:4700::1111"]) assert.equal(isBlockedAddress(ip), false, ip);
  for (const link of ["http://127.0.0.1/", "http://localhost/", "http://169.254.169.254/latest/meta-data/", "http://[::1]/", "http://example.com:8080/", "http://u:p@example.com/"]) {
    const info = await fetchLinkInfo(link, { timeoutMs: 1500 });
    assert.equal(info.fetched, false, link); assert.ok(info.note, link);
  }
  const parsed = parseHtml('<html><head><title> 旧标题 </title><meta content="液态硅胶壳 &amp; 防摔" property="og:title"><meta name="description" content="亲肤&#x20;手感"></head></html>');
  assert.deepEqual(parsed, { pageTitle: "液态硅胶壳 & 防摔", description: "亲肤 手感", keywords: "" });
  assert.equal(cleanTitle('\n标题：「硅胶手机壳  适用 iPhone」\n以上是标题'), "硅胶手机壳 适用 iPhone");
});

// ---------- 亚马逊商品链接 ----------
const { parseAmazonHtml, extractAsin, canonicalAmazonUrl, detectPlatform } = require("../src/linkInfo");
const { buildMessages } = require("../src/agent");

test("亚马逊：识别各站点域名和短链接，提取 ASIN 并统一成 /dp/ASIN", () => {
  for (const host of ["www.amazon.com", "amazon.com", "www.amazon.co.uk", "www.amazon.de", "www.amazon.co.jp", "www.amazon.com.mx", "smile.amazon.com", "a.co", "amzn.to"]) {
    assert.equal(detectPlatform(host), "亚马逊", host);
  }
  for (const host of ["amazon.com.evil.com", "notamazon.com", "amazon.example.org", "www.apple.com"]) {
    assert.notEqual(detectPlatform(host), "亚马逊", host);
  }
  const asin = (link) => extractAsin(new URL(link));
  assert.equal(asin("https://www.amazon.com/dp/B0CHX3QBCH"), "B0CHX3QBCH");
  assert.equal(asin("https://www.amazon.com/Apple-iPhone-Case/dp/b0chx3qbch/ref=sr_1_3?keywords=case"), "B0CHX3QBCH");
  assert.equal(asin("https://www.amazon.com/gp/product/B0CHX3QBCH?th=1"), "B0CHX3QBCH");
  assert.equal(asin("https://www.amazon.com/gp/aw/d/B0CHX3QBCH"), "B0CHX3QBCH");
  assert.equal(asin("https://www.amazon.com/s?k=iphone+case"), "");
  assert.equal(asin("https://www.amazon.com/dp/SHORT"), "");
  assert.equal(
    canonicalAmazonUrl(new URL("https://www.amazon.co.uk/Some-Long-Title/dp/B0CHX3QBCH/ref=x?tag=abc&th=1")).href,
    "https://www.amazon.co.uk/dp/B0CHX3QBCH"
  );
  assert.equal(canonicalAmazonUrl(new URL("https://www.amazon.com/s?k=case")).href, "https://www.amazon.com/s?k=case");
});

test("亚马逊：从商品页解析标题、品牌、五点描述、规格、类目", () => {
  const html = fs.readFileSync(path.join(__dirname, "fixtures/amazon-product.html"), "utf8");
  const product = parseAmazonHtml(html);
  assert.equal(product.title, "Apple iPhone 15 Plus Clear Case with MagSafe");
  assert.equal(product.brand, "Apple");
  assert.equal(product.category, "Cell Phones & Accessories");
  assert.equal(product.bullets.length, 4);
  assert.match(product.bullets[0], /polycarbonate/);
  assert.equal(product.bullets[3], "Compatible with iPhone 15 Plus");
  assert.deepEqual(product.attributes.find((item) => item.name === "Material"), { name: "Material", value: "Polycarbonate" });
  assert.ok(product.bullets.every((bullet) => !/[<>]/.test(bullet)));
  // 不是商品页时什么都解析不出来，不能把别的内容当成商品标题
  assert.deepEqual(parseAmazonHtml("<html><head><title>Amazon.com</title></head><body>home</body></html>"), {
    title: "", brand: "", bullets: [], attributes: [], category: ""
  });
});

test("亚马逊：商品卖点和规格进入提示词，并要求用中文提炼；extractedInfo 返回结构化信息", async () => {
  const linkInfo = {
    sourceUrl: "https://www.amazon.com/dp/B0CHX3QBCH", host: "www.amazon.com", platform: "亚马逊", fetched: true, note: "",
    asin: "B0CHX3QBCH", pageTitle: "Apple iPhone 15 Plus Clear Case with MagSafe", brand: "Apple", category: "Cell Phones & Accessories",
    description: "", keywords: "", bullets: ["Scratch-resistant coating", "Built-in magnets for MagSafe"],
    attributes: [{ name: "Material", value: "Polycarbonate" }]
  };
  const prompt = buildMessages({ products: [{ model: "iPhone 18 Pro", color: "黑色", category: "手机壳", attributes: [] }], linkInfo })[1].content;
  assert.match(prompt, /平台：亚马逊/);
  assert.match(prompt, /爆款标题：Apple iPhone 15 Plus Clear Case with MagSafe/);
  assert.match(prompt, /爆款规格：Material=Polycarbonate/);
  assert.match(prompt, /1\. Scratch-resistant coating/);
  assert.match(prompt, /2\. Built-in magnets for MagSafe/);
  assert.match(prompt, /用中文表达/);
  assert.match(prompt, /机型只能来自【关联商品】/);

  const calls = [];
  const s = await start({ fetchImpl: modelFetch([GOOD], calls), linkFetcher: async () => linkInfo });
  const token = await s.login();
  const r = await s.call("POST", "/api/agent/hot-product/recognize", { token, body: { productIds: [2], hotLink: linkInfo.sourceUrl } });
  assert.equal(r.json.code, 0);
  assert.equal(r.json.data.extractedInfo.platform, "亚马逊");
  assert.equal(r.json.data.extractedInfo.asin, "B0CHX3QBCH");
  assert.equal(r.json.data.extractedInfo.bullets.length, 2);
  assert.match(calls[0].body.messages[1].content, /Built-in magnets for MagSafe/);
  await s.close();
});

// ---------- 亚马逊：直连被拦截时走商品数据服务 ----------
const AMAZON_PAGE = fs.readFileSync(path.join(__dirname, "fixtures/amazon-product.html"));
const BLOCK_PAGE = Buffer.from('<html><body><form action="/errors/validateCaptcha">Enter the characters you see below</form></body></html>');
const page = (status, body = AMAZON_PAGE) => ({ status, headers: { "content-type": "text/html; charset=utf-8" }, body });
const SCRAPER = { apiKey: "test-scraper-key", baseUrl: "https://api.scraperapi.com/", timeoutMs: 5000, always: false };

// 模拟网络层：按请求的主机名返回预设响应，并记录请求过的地址
function fakeRequest(handlers, seen = []) {
  return async (url) => {
    seen.push(url);
    const reply = handlers[url.hostname];
    if (reply instanceof Error) throw reply;
    if (!reply) throw new Error("unexpected host " + url.hostname);
    return typeof reply === "function" ? reply(url) : reply;
  };
}

test("商品数据服务：直连被拦截时改走它，目标地址是统一后的 /dp/ASIN", async () => {
  const seen = [];
  const requestImpl = fakeRequest({ "www.amazon.ca": page(200, BLOCK_PAGE), "api.scraperapi.com": page(200) }, seen);
  const info = await fetchLinkInfo("https://www.amazon.ca/Some-Title/dp/B0CHX3QBCH/ref=sr_1_1?tag=x", { scraper: SCRAPER, requestImpl });
  assert.equal(info.fetched, true);
  assert.equal(info.source, "scraper");
  assert.equal(info.pageTitle, "Apple iPhone 15 Plus Clear Case with MagSafe");
  assert.equal(info.bullets.length, 4);
  assert.equal(seen.length, 2);
  assert.equal(seen[1].hostname, "api.scraperapi.com");
  assert.equal(seen[1].searchParams.get("url"), "https://www.amazon.ca/dp/B0CHX3QBCH");
  assert.equal(seen[1].searchParams.get("api_key"), "test-scraper-key");
  assert.equal(seen[1].searchParams.get("country_code"), null);
  // 密钥不能出现在返回给前端的信息里
  assert.ok(!JSON.stringify(info).includes("test-scraper-key"));

  // 同一站点刚被拦截过：下一次不再重复直连，直接走商品数据服务
  seen.length = 0;
  const again = await fetchLinkInfo("https://www.amazon.ca/dp/B0CHX3QBCH", { scraper: SCRAPER, requestImpl });
  assert.equal(again.fetched, true);
  assert.deepEqual(seen.map((u) => u.hostname), ["api.scraperapi.com"]);
});

test("商品数据服务：直连成功时不调用；未配置密钥时保持原来的拦截提示", async () => {
  let seen = [];
  let info = await fetchLinkInfo("https://www.amazon.fr/dp/B0CHX3QBCH", { scraper: SCRAPER, requestImpl: fakeRequest({ "www.amazon.fr": page(200) }, seen) });
  assert.equal(info.fetched, true);
  assert.equal(info.source, undefined);
  assert.deepEqual(seen.map((u) => u.hostname), ["www.amazon.fr"]);

  seen = [];
  info = await fetchLinkInfo("https://www.amazon.it/dp/B0CHX3QBCH", { scraper: { ...SCRAPER, apiKey: "" }, requestImpl: fakeRequest({ "www.amazon.it": page(503, BLOCK_PAGE) }, seen) });
  assert.equal(info.fetched, false);
  assert.match(info.note, /亚马逊暂时拒绝了读取请求/);
  assert.equal(seen.length, 1);

  // SCRAPER_ALWAYS：不先尝试直连
  seen = [];
  info = await fetchLinkInfo("https://www.amazon.es/dp/B0CHX3QBCH", { scraper: { ...SCRAPER, always: true }, requestImpl: fakeRequest({ "api.scraperapi.com": page(200) }, seen) });
  assert.equal(info.fetched, true);
  assert.deepEqual(seen.map((u) => u.hostname), ["api.scraperapi.com"]);

  // 非亚马逊链接永远不走商品数据服务
  seen = [];
  info = await fetchLinkInfo("https://shop.example.com/item/1", { scraper: { ...SCRAPER, always: true }, requestImpl: fakeRequest({ "shop.example.com": page(200, Buffer.from("<title>某商品</title>")) }, seen) });
  assert.equal(info.pageTitle, "某商品");
  assert.deepEqual(seen.map((u) => u.hostname), ["shop.example.com"]);
});

test("商品数据服务：密钥无效、限流、超时、服务故障、商品不存在都有明确提示", async () => {
  const run = async (host, reply) =>
    fetchLinkInfo(`https://${host}/dp/B0CHX3QBCH`, { scraper: SCRAPER, requestImpl: fakeRequest({ [host]: page(503, BLOCK_PAGE), "api.scraperapi.com": reply }) });
  const cases = [
    ["www.amazon.nl", page(401, Buffer.from("Unauthorized request, please make sure your API key is valid.")), /密钥无效或额度不足/],
    ["www.amazon.se", page(403, Buffer.from("You have exhausted the API Credits")), /密钥无效或额度不足/],
    ["www.amazon.pl", page(429, Buffer.from("Too many requests")), /请求过于频繁/],
    ["www.amazon.sg", page(500, Buffer.from("Request failed")), /暂时不可用（HTTP 500）/],
    ["www.amazon.ae", new Error("抓取超时"), /读取超时/],
    ["www.amazon.sa", Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }), /连接失败/],
    ["www.amazon.in", page(404, Buffer.from("Not found")), /找不到这个商品/],
    ["www.amazon.com.au", page(200, BLOCK_PAGE), /亚马逊暂时拒绝了读取请求/]
  ];
  for (const [host, reply, expected] of cases) {
    const info = await run(host, reply);
    assert.equal(info.fetched, false, host);
    assert.equal(info.platform, "亚马逊", host);
    assert.match(info.note, expected, host);
    assert.ok(!info.note.includes("test-scraper-key") && !/Unauthorized|exhausted|hang up/.test(info.note), host);
  }
});

test("商品数据服务：接口把配置和剩余时间传给读取层；健康检查显示是否已配置", async () => {
  let received;
  const s = await start({
    env: { SCRAPER_API_KEY: "test-scraper-key" },
    linkFetcher: async (link, options) => {
      received = options;
      return { sourceUrl: link, host: "www.amazon.com", platform: "亚马逊", fetched: true, source: "scraper", pageTitle: "Case", description: "", keywords: "", note: "", bullets: ["A"], attributes: [] };
    }
  });
  const token = await s.login();
  const health = await s.call("GET", "/api/health");
  assert.equal(health.json.data.amazonDataServiceConfigured, true);
  assert.ok(!JSON.stringify(health.json).includes("test-scraper-key"));
  const before = Date.now();
  const r = await s.call("POST", "/api/agent/hot-product/recognize", { token, body: { productIds: [2], hotLink: "https://www.amazon.com/dp/B0CHX3QBCH" } });
  assert.equal(r.json.data.extractedInfo.source, "scraper");
  assert.equal(received.scraper.apiKey, "test-scraper-key");
  // 留给商品数据服务的截止时间 = 总预算 50 秒 - 给模型预留的 5 秒
  assert.ok(received.scraperDeadlineMs - before > 43000 && received.scraperDeadlineMs - before <= 45500);
  assert.ok(!JSON.stringify(r.json).includes("test-scraper-key"));
  await s.close();

  const off = await start();
  assert.equal((await off.call("GET", "/api/health")).json.data.amazonDataServiceConfigured, false);
  await off.close();
});

test("商品数据服务：服务器直连亚马逊站点失败时也改走它；未配置时保持原来的失败提示", async () => {
  const down = Object.assign(new Error("connect ECONNRESET"), { code: "ECONNRESET" });
  const seen = [];
  let info = await fetchLinkInfo("https://www.amazon.co.jp/dp/B0CHX3QBCH", {
    scraper: SCRAPER,
    requestImpl: fakeRequest({ "www.amazon.co.jp": down, "api.scraperapi.com": page(200) }, seen)
  });
  assert.equal(info.fetched, true);
  assert.equal(info.source, "scraper");
  assert.deepEqual(seen.map((u) => u.hostname), ["www.amazon.co.jp", "api.scraperapi.com"]);
  assert.equal(seen[1].searchParams.get("country_code"), null);

  info = await fetchLinkInfo("https://www.amazon.com.br/dp/B0CHX3QBCH", {
    scraper: { ...SCRAPER, apiKey: "" },
    requestImpl: fakeRequest({ "www.amazon.com.br": down })
  });
  assert.equal(info.fetched, false);
  assert.equal(info.note, "未能读取链接内容：网络连接失败");
});

test("商品数据服务：美国站带 country_code=us；同一商品的不同链接写法共用缓存，不重复读取", async () => {
  const { linkCacheKey } = require("../src/linkInfo");
  assert.equal(linkCacheKey("https://www.amazon.com/Some-Title/dp/b0chx3qbch/ref=sr_1_1?tag=x"), "amazon:amazon.com:B0CHX3QBCH");
  assert.equal(linkCacheKey("https://amazon.com/gp/product/B0CHX3QBCH?th=1"), "amazon:amazon.com:B0CHX3QBCH");
  assert.notEqual(linkCacheKey("https://www.amazon.co.uk/dp/B0CHX3QBCH"), linkCacheKey("https://www.amazon.com/dp/B0CHX3QBCH"));
  assert.equal(linkCacheKey("https://shop.example.com/item?id=1"), "https://shop.example.com/item?id=1");
  assert.equal(linkCacheKey("not a url"), "not a url");

  const seen = [];
  const us = await fetchLinkInfo("https://www.amazon.com/dp/B0CHX3QBCH", {
    scraper: { ...SCRAPER, always: true },
    requestImpl: fakeRequest({ "api.scraperapi.com": page(200) }, seen)
  });
  assert.equal(us.fetched, true);
  assert.equal(seen[0].searchParams.get("country_code"), "us");
  // url 参数必须排在最后，避免和目标链接自带的参数混淆
  assert.equal([...seen[0].searchParams.keys()].pop(), "url");

  let reads = 0;
  const s = await start({
    env: { SCRAPER_API_KEY: "test-scraper-key" },
    linkFetcher: async (link) => {
      reads += 1;
      return { sourceUrl: link, host: "www.amazon.com", platform: "亚马逊", fetched: true, source: "scraper", pageTitle: "Case", description: "", keywords: "", note: "", bullets: ["A"], attributes: [] };
    }
  });
  const token = await s.login();
  const body = (hotLink) => ({ token, body: { productIds: [2], hotLink } });
  await s.call("POST", "/api/agent/hot-product/recognize", body("https://www.amazon.com/dp/B0CHX3QBCH"));
  await s.call("POST", "/api/agent/hot-product/recognize", body("https://www.amazon.com/Long-Title/dp/B0CHX3QBCH/ref=sr_1_1?keywords=case"));
  await s.call("POST", "/api/agent/hot-product/regenerate-title", { token, body: { productIds: [2], hotLink: "https://www.amazon.com/gp/product/B0CHX3QBCH", previousTitle: "旧标题" } });
  assert.equal(reads, 1);
  await s.call("POST", "/api/agent/hot-product/recognize", body("https://www.amazon.com/dp/B0DCZ4WZQ1"));
  assert.equal(reads, 2);
  await s.close();
});

test("读取层：未压缩的响应读到卖点区块后提前结束，不等整页传完", async () => {
  const head = Buffer.from(fs.readFileSync(path.join(__dirname, "fixtures/amazon-product.html")));
  const filler = Buffer.alloc(64 * 1024, "x");
  let sent = 0;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.write(head);
    sent = head.length;
    // 之后持续发送无关内容；读取层应当在卖点之后不久就断开
    const timer = setInterval(() => { sent += filler.length; if (!res.write(filler)) { /* 忽略背压 */ } }, 5);
    res.on("close", () => clearInterval(timer));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  server.unref();
  const { requestForTest } = require("../src/linkInfo");
  const started = Date.now();
  const res = await requestForTest(new URL(`http://127.0.0.1:${server.address().port}/`), Date.now() + 4000, 8 * 1024 * 1024, {
    marker: Buffer.from('id="feature-bullets"'),
    tail: 16 * 1024
  });
  assert.ok(Date.now() - started < 2000);
  assert.ok(res.body.length < head.length + 256 * 1024, `读了 ${res.body.length} 字节`);
  assert.equal(parseAmazonHtml(res.body.toString("utf8")).bullets.length, 4);
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

test("读取层：压缩传输的响应边解压边读，读到卖点区块后同样提前结束", async () => {
  const zlib = require("node:zlib");
  const crypto = require("node:crypto");
  const head = fs.readFileSync(path.join(__dirname, "fixtures/amazon-product.html"));
  const server = http.createServer((req, res) => {
    assert.match(req.headers["accept-encoding"], /gzip/);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Encoding": "gzip" });
    const gzip = zlib.createGzip();
    gzip.pipe(res);
    gzip.write(head);
    gzip.flush();
    // 之后持续发送压不动的随机内容
    const timer = setInterval(() => { gzip.write(crypto.randomBytes(32 * 1024).toString("base64")); gzip.flush(); }, 5);
    res.on("close", () => clearInterval(timer));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  server.unref();
  const { requestForTest } = require("../src/linkInfo");
  const started = Date.now();
  const res = await requestForTest(new URL(`http://127.0.0.1:${server.address().port}/`), Date.now() + 4000, 8 * 1024 * 1024, {
    marker: Buffer.from('id="feature-bullets"'),
    tail: 16 * 1024
  });
  assert.ok(Date.now() - started < 2000);
  assert.ok(res.body.length < head.length + 256 * 1024, `读了 ${res.body.length} 字节`);
  assert.equal(parseAmazonHtml(res.body.toString("utf8")).title, "Apple iPhone 15 Plus Clear Case with MagSafe");
  assert.equal(parseAmazonHtml(res.body.toString("utf8")).bullets.length, 4);
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});
