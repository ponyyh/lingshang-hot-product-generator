// 可选：让模型请求绕过本机代理直连。
// 本机开着全局代理时，代理节点可能连不上方舟（握手被重置），这时在 .env 里配置
// ARK_LOCAL_ADDRESS（本机网卡 IP）和 ARK_CONNECT_IP（方舟的真实 IP），模型请求就从该网卡直接发出。
// 部署在没有代理的服务器上时不需要配置。

const https = require("node:https");

function createDirectFetch({ localAddress, connectIp }) {
  const lookup = (hostname, options, callback) =>
    options.all ? callback(null, [{ address: connectIp, family: 4 }]) : callback(null, connectIp, 4);

  return function directFetch(url, init = {}) {
    return new Promise((resolve, reject) => {
      const target = new URL(url);
      const body = init.body || "";
      const req = https.request(
        {
          host: target.hostname,
          path: target.pathname + target.search,
          method: init.method || "GET",
          localAddress,
          family: 4,
          lookup,
          headers: { ...init.headers, "Content-Length": Buffer.byteLength(body) }
        },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode })));
          res.on("error", reject);
        }
      );
      req.on("error", reject);
      if (init.signal) {
        const abort = () => req.destroy(init.signal.reason);
        if (init.signal.aborted) abort();
        else init.signal.addEventListener("abort", abort, { once: true });
      }
      req.end(body);
    });
  };
}

module.exports = { createDirectFetch };
