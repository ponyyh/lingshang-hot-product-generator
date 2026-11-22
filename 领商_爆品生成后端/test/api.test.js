const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { createHandler } = require("../src/app");
const { loadConfig } = require("../src/config");
const { isBlockedAddress, parseHtml, fetchLinkInfo } = require("../src/linkInfo");
const { cleanTitle } = require("../src/agent");
const { csvCell } = require("../src/exporter");

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

test("商品列表：分页、搜索、空结果、非法参数", async () => {
  const s = await start(); const token = await s.login();
  const all = (await s.call("GET", "/api/products", { token })).json.data;
  assert.equal(all.total, 200); assert.equal(all.list.length, 200);
  assert.deepEqual(Object.keys(all.list[0]), ["id", "name", "color", "weight", "price", "packaging"]);
  const page = (await s.call("GET", "/api/products?page=2&pageSize=10", { token })).json.data;
  assert.equal(page.list[0].id, 11); assert.equal(page.list.length, 10);
  const kw = (await s.call("GET", "/api/products?keyword=" + encodeURIComponent("樱花粉"), { token })).json.data;
  assert.ok(kw.total > 0 && kw.list.every((p) => p.color === "樱花粉"));
  const empty = (await s.call("GET", "/api/products?keyword=zzzz", { token })).json.data;
  assert.deepEqual([empty.total, empty.list], [0, []]);
  assert.equal((await s.call("GET", "/api/products?pageSize=0", { token })).json.code, 40001);
  assert.equal((await s.call("GET", "/api/products?page=abc", { token })).json.code, 40001);
  await s.close();
});

test("识别：成功返回 taskId/title/extractedInfo，密钥只发给模型服务", async () => {
  const calls = []; const s = await start({ fetchImpl: modelFetch([`标题：“${GOOD}”\n说明：xxx`], calls) }); const token = await s.login();
  const r = await s.call("POST", "/api/agent/hot-product/recognize", { token, body: { productIds: [1, 2, 2, 3], hotLink: "https://x.com/item" } });
  assert.equal(r.json.code, 0);
  assert.match(r.json.data.taskId, /^task_\d{8}_[0-9a-f]{8}$/);
  assert.equal(r.json.data.title, GOOD);
  assert.equal(r.json.data.extractedInfo.matchedCount, 3);
  assert.equal(calls.length, 1); assert.equal(calls[0].auth, "Bearer k");
  assert.match(calls[0].body.messages[1].content, /Samsung S26/);
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

test("导出：返回带 BOM 的 CSV 文件；违规标题在服务端被拦截", async () => {
  const s = await start(); const token = await s.login();
  const ok = await s.call("POST", "/api/hot-product/export", { token, body: { taskId: "t", productIds: [1, 2], hotLink: "https://x.com/a?b=1,2", title: GOOD } });
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get("content-type"), /text\/csv/);
  assert.match(ok.headers.get("content-disposition"), /filename\*=UTF-8''%E9%A2%86%E5%95%86/);
  assert.deepEqual([...ok.buf.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const lines = ok.buf.toString("utf8").slice(1).trim().split("\r\n");
  assert.equal(lines.length, 3);
  assert.equal(lines[0], '"爆款链接","生成标题","商品名称","颜色","重量","价格","外包装形状"');
  assert.ok(lines[1].startsWith('"https://x.com/a?b=1,2","' + GOOD + '","Samsung S26","黑色"'));
  const bad = await s.call("POST", "/api/hot-product/export", { token, body: { productIds: [1], hotLink: "https://x.com", title: "顶级硅胶手机壳 适用iPhone 18 Pro" } });
  assert.equal(bad.json.code, 42201); assert.match(bad.json.message, /顶级/);
  assert.equal(csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
  await s.close();
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
