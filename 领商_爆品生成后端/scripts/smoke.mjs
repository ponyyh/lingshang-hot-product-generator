// 线上验收脚本：对已部署的后端逐个接口做真实请求。
// 用法：BASE_URL=https://xxx.vercel.app TEST_USER=账号 TEST_PASS=密码 node scripts/smoke.mjs
import { createRequire } from "node:module";
const { readXlsx } = createRequire(import.meta.url)("../src/xlsx.js");

const BASE = (process.env.BASE_URL || "http://localhost:8787").replace(/\/$/, "");
const USER = process.env.TEST_USER || "";
const PASS = process.env.TEST_PASS || "";
const ORIGIN = process.env.FRONT_ORIGIN || "https://example-frontend.vercel.app";
const HOT_LINK = process.env.HOT_LINK || "https://www.apple.com.cn/shop/product/MA7E4FE/A";

let failed = 0;
function check(name, ok, detail = "") {
  if (!ok) failed += 1;
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? "  — " + detail : ""}`);
}

async function call(method, path, { body, token, headers = {} } = {}) {
  const started = Date.now();
  const res = await fetch(BASE + path, {
    method,
    headers: {
      Origin: ORIGIN,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(65000)
  });
  const type = res.headers.get("content-type") || "";
  const out = { status: res.status, headers: res.headers, ms: Date.now() - started };
  if (type.includes("json")) out.json = await res.json();
  else out.buf = Buffer.from(await res.arrayBuffer());
  return out;
}

const health = await call("GET", "/api/health");
check("健康检查", health.json?.code === 0, JSON.stringify(health.json?.data));
check("Agent 已配置", health.json?.data?.agentConfigured === true);
check("鉴权已开启", health.json?.data?.authRequired === true);

const pre = await call("OPTIONS", "/api/agent/hot-product/recognize", {
  headers: { "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,content-type" }
});
check(
  "跨域预检",
  pre.status === 204 && Boolean(pre.headers.get("access-control-allow-origin")) && /authorization/i.test(pre.headers.get("access-control-allow-headers") || ""),
  `HTTP ${pre.status} allow-origin=${pre.headers.get("access-control-allow-origin")}`
);

const noAuth = await call("GET", "/api/products");
check("未登录被拒绝", noAuth.json?.code === 40101, noAuth.json?.message);

const badLogin = await call("POST", "/api/auth/login", { body: { username: USER || "nobody", password: "wrong-password" } });
check("错误密码被拒绝", badLogin.json?.code === 40102, badLogin.json?.message);

const login = await call("POST", "/api/auth/login", { body: { username: USER, password: PASS } });
const token = login.json?.data?.token;
check("测试账号登录", login.json?.code === 0 && Boolean(token), login.json?.message);
if (!token) {
  console.log("\n没有拿到令牌，后续接口无法验证。请检查 TEST_USER / TEST_PASS。");
  process.exit(1);
}

const products = await call("GET", "/api/products?page=1&pageSize=200", { token });
const list = products.json?.data?.list || [];
check("商品列表", products.json?.data?.total > 0 && list.length === products.json.data.total, `total=${products.json?.data?.total} ${products.ms}ms`);
check(
  "商品字段与商品表一致",
  list.length > 0 && ["title", "variantName", "skuCode", "declaredPrice", "weight", "packagingShape", "packagingType", "previewImage"].every((key) => typeof list[0][key] === "string"),
  list[0] ? `${list[0].title} / ${list[0].variantName} / ${list[0].skuCode}` : ""
);
const search = await call("GET", "/api/products?keyword=" + encodeURIComponent(list[0]?.skuCode || "x"), { token });
check("商品搜索（按 SKU货号）", search.json?.data?.total === 1, `total=${search.json?.data?.total}`);
const empty = await call("GET", "/api/products?keyword=" + encodeURIComponent("不存在的商品"), { token });
check("搜索空结果", empty.json?.code === 0 && empty.json.data.total === 0 && empty.json.data.list.length === 0);

const productIds = list.slice(0, 2).map((item) => item.id);
const rec = await call("POST", "/api/agent/hot-product/recognize", { token, body: { productIds, hotLink: HOT_LINK } });
const recData = rec.json?.data || {};
check("识别爆款链接（真实模型）", rec.json?.code === 0 && Boolean(recData.title), `${rec.ms}ms 链接已读取=${recData.extractedInfo?.fetched}`);
console.log(`     标题：${recData.title || rec.json?.message}`);
check("识别耗时在前端 60 秒超时内", rec.ms < 60000, `${rec.ms}ms`);

const regen = await call("POST", "/api/agent/hot-product/regenerate-title", {
  token,
  body: { taskId: recData.taskId, productIds, hotLink: HOT_LINK, previousTitle: recData.title }
});
check("重新生成标题（真实模型）", regen.json?.code === 0 && Boolean(regen.json.data.title) && regen.json.data.taskId === recData.taskId, `${regen.ms}ms`);
console.log(`     标题：${regen.json?.data?.title || regen.json?.message}`);

const badRec = await call("POST", "/api/agent/hot-product/recognize", { token, body: { productIds: [], hotLink: HOT_LINK } });
check("识别缺少商品时提示", badRec.json?.code === 40001, badRec.json?.message);

const title = regen.json?.data?.title || recData.title || "";
const pass = await call("POST", "/api/compliance/validate-title", { token, body: { title, productIds } });
check("校验：生成的标题通过", pass.json?.data?.passed === true, JSON.stringify(pass.json?.data));
const sensitive = await call("POST", "/api/compliance/validate-title", { token, body: { title: "赌博专用手机壳 适用iPhone 18 Pro 防摔", productIds } });
check("校验：敏感词被拦截", sensitive.json?.data?.passed === false && sensitive.json.data.violationType === "sensitive", sensitive.json?.data?.inlineMsg);
const extreme = await call("POST", "/api/compliance/validate-title", { token, body: { title: "全网最低价硅胶手机壳 适用iPhone 18 Pro", productIds } });
check("校验：极限词被拦截", extreme.json?.data?.passed === false && extreme.json.data.violationType === "platform", extreme.json?.data?.inlineMsg);

const exp = await call("POST", "/api/hot-product/export", { token, body: { taskId: recData.taskId, productIds, hotLink: HOT_LINK, title } });
let sheet = { sheetName: "", rows: [] };
try {
  sheet = readXlsx(exp.buf);
} catch (err) {
  sheet.error = err.message;
}
const header = sheet.rows[0] || [];
const cell = (row, name) => (sheet.rows[row] || [])[header.indexOf(name)];
check(
  "导出 xlsx 文件",
  exp.status === 200 && /spreadsheetml\.sheet/.test(exp.headers.get("content-type") || "") && sheet.rows.length === productIds.length + 1,
  sheet.error || `${exp.buf?.length || 0} 字节，工作表 ${sheet.sheetName}，${header.length} 列，${sheet.rows.length - 1} 行商品`
);
check(
  "导出内容：表头为商品表的列，标题和来源链接已写入",
  header[0] === "产品标题" && header.includes("SKU货号") && header.includes("来源URL") && cell(1, "产品标题") === title && cell(1, "来源URL") === HOT_LINK && cell(1, "SKU货号") === list[0].skuCode,
  `产品标题=${String(cell(1, "产品标题")).slice(0, 30)}… SKU货号=${cell(1, "SKU货号")}`
);
const badExp = await call("POST", "/api/hot-product/export", { token, body: { productIds, hotLink: HOT_LINK, title: "顶级硅胶手机壳 适用iPhone 18 Pro 防摔" } });
check("导出：违规标题被服务端拦截", badExp.json?.code === 42201, badExp.json?.message);

const notFound = await call("GET", "/api/not-exist", { token });
check("未知接口返回 404", notFound.status === 404 && notFound.json?.code === 40401);

console.log(failed === 0 ? "\n全部通过" : `\n有 ${failed} 项未通过`);
process.exit(failed === 0 ? 0 : 1);
