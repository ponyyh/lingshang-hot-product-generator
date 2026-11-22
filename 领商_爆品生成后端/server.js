// 运行入口：node server.js（读取同目录 .env）。
// 同一个端口同时提供后端接口（/api/*）和前端页面（其余路径），前后端同源，不需要跨域。
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const envFile = path.join(__dirname, ".env");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const { createHandler } = require("./src/app");
const { createDirectFetch } = require("./src/directFetch");

// 本地开发直接读同级的前端目录；部署包里没有它，改读打包时复制进来的 ./public
const SIBLING_FRONTEND = path.join(__dirname, "../领商_爆品生成网站");
const FRONTEND_DIR = path.resolve(
  __dirname,
  process.env.FRONTEND_DIR || (fs.existsSync(SIBLING_FRONTEND) ? SIBLING_FRONTEND : "./public")
);
// 只对外提供页面运行需要的文件，文档等其他文件不暴露
const STATIC_FILES = new Set(["/index.html", "/styles.css", "/api.js", "/app.js"]);
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

function serveStatic(req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  } catch {
    pathname = "";
  }
  if (pathname === "/") pathname = "/index.html";
  const allowed = STATIC_FILES.has(pathname) || /^\/assets\/[\w.-]+\.(png|svg)$/.test(pathname);
  const filePath = path.join(FRONTEND_DIR, pathname);
  if (!allowed || (req.method !== "GET" && req.method !== "HEAD") || !fs.existsSync(filePath)) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("页面不存在");
    return;
  }
  res.writeHead(200, {
    "Content-Type": MIME[path.extname(filePath)],
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff"
  });
  if (req.method === "HEAD") res.end();
  else fs.createReadStream(filePath).pipe(res);
}

const overrides = {};
if (process.env.ARK_LOCAL_ADDRESS && process.env.ARK_CONNECT_IP) {
  overrides.fetchImpl = createDirectFetch({
    localAddress: process.env.ARK_LOCAL_ADDRESS,
    connectIp: process.env.ARK_CONNECT_IP
  });
  console.log(`模型请求经 ${process.env.ARK_LOCAL_ADDRESS} 直连，不走代理`);
}
const api = createHandler(overrides);

const port = Number(process.env.PORT) || 8787;
http
  .createServer((req, res) => {
    if (req.url === "/api" || req.url.startsWith("/api/") || req.url.startsWith("/api?")) api(req, res);
    else serveStatic(req, res);
  })
  // 本地默认只监听本机；部署到云上时设置 HOST=0.0.0.0
  .listen(port, process.env.HOST || "127.0.0.1", () => {
    console.log(`领商 · 爆品生成 已启动，端口 ${port}`);
  });
