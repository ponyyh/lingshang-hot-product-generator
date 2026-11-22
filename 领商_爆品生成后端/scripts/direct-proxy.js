// 临时本地转发：只监听本机，把 CONNECT 请求从 Wi-Fi 网卡直连出去（绕过全局代理），域名用 DoH 解析真实 IP。
const http = require("node:http"), net = require("node:net");
const LOCAL = process.env.LOCAL_ADDR, cache = new Map();
async function resolve(host) {
  if (net.isIP(host)) return host;
  if (cache.has(host)) return cache.get(host);
  const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${host}&type=A`, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(8000) });
  const ip = (await r.json()).Answer?.find((a) => a.type === 1)?.data;
  if (!ip) throw new Error("no A record for " + host);
  cache.set(host, ip); return ip;
}
const server = http.createServer((req, res) => { res.writeHead(405); res.end(); });
server.on("connect", async (req, client, head) => {
  const [host, port] = req.url.split(":");
  try {
    const ip = await resolve(host);
    const upstream = net.connect({ host: ip, port: Number(port) || 443, localAddress: LOCAL }, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(client); client.pipe(upstream);
    });
    upstream.on("error", (e) => { console.log("ERR", host, e.code || e.message); client.destroy(); });
    client.on("error", () => upstream.destroy());
    console.log("CONNECT", host, "->", ip);
  } catch (e) { console.log("FAIL", host, e.message); client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"); }
});
server.listen(18899, "127.0.0.1", () => console.log("direct proxy on 127.0.0.1:18899 via", LOCAL));
