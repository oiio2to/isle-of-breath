"use strict";
/* Minimal reference server for Isle of Breath.
 * 最小参考服务器：把森林与温室挂到一个裸 Node HTTP 分发器上。
 *
 *   node example/server.js          # listens on :8080
 *
 * This is a demonstration, not a deployment. No auth, no TLS, no rate
 * limiting — put it behind your own gateway before exposing it anywhere.
 * 这是演示，不是部署形态：没有鉴权、没有 TLS、没有限流。 */

const http = require("http");
const forest = require("../src/forest");
const greenhouse = require("../src/greenhouse");

const PORT = process.env.PORT || 8080;

const json = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
};

http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost");
  const p = u.pathname;
  try {
    if (p.startsWith("/api/forest") || p.startsWith("/forest"))
      return await forest(req, res, u, json);
    if (p.startsWith("/api/greenhouse") || p.startsWith("/greenhouse"))
      return await greenhouse(req, res, u, json);
    return json(res, 404, { error: "not found. try /api/forest/state or /api/greenhouse/state" });
  } catch (e) {
    return json(res, 500, { error: String((e && e.message) || e) });
  }
}).listen(PORT, () => console.log("Isle of Breath example server on :" + PORT));
