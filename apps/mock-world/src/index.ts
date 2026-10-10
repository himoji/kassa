// Phase 0 placeholder: Phase 1 replaces this with the Fastify mock world (spec §17). Everything here is simulated.
import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 4001);

createServer((req, res) => {
  if (req.url === "/mock/health" || req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "mock-world", simulated: true }));
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
}).listen(port, () => {
  console.log(`[mock-world] listening on :${port}`);
});
