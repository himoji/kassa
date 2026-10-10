// Phase 0 placeholder: Phase 1 replaces this with the Fastify server (spec §8).
import { createServer } from "node:http";

import { ReasonCode } from "@kassa/shared";

const port = Number(process.env.PORT ?? 4000);

createServer((req, res) => {
  if (req.url === "/api/health" || req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "api", reasonCodes: ReasonCode.options.length }));
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
}).listen(port, () => {
  console.log(`[api] listening on :${port}`);
});
