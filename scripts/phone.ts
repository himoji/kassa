#!/usr/bin/env bun
/**
 * `bun run phone` - put the local demo on real phones over one HTTPS origin (apps/mobile/README.md "Running on a
 * physical iPhone", now one command).
 *
 * 1. A single-origin proxy on PHONE_PORT (default 8080), the same routing as the repo Caddyfile:
 *      /api*  -> 127.0.0.1:API_PORT (4000)      /mock* -> 127.0.0.1:MOCK_PORT (4001)
 *      else   -> the web export in apps/mobile/dist (SPA fallback to index.html) if it exists,
 *                otherwise Expo web on 127.0.0.1:WEB_PORT (8081).
 * 2. A Cloudflare tunnel to it:
 *      - CLOUDFLARED_TUNNEL=<name> and PHONE_HOST=<hostname> set: `cloudflared tunnel run <name>` (a named tunnel with
 *        a stable hostname; route PHONE_HOST to it once with `cloudflared tunnel route dns <name> <host>`). RP_ID stays
 *        the same across restarts, so passkeys made on the phones keep working.
 *      - otherwise a quick tunnel (`cloudflared tunnel --url ...`) on a random trycloudflare.com host. Passkeys are
 *        bound to RP_ID = that host: after a restart the host changes and every passkey made on it stops working.
 * 3. Prints the env block for the API, mock-world and the web export (RP_ID, PUBLIC_ORIGIN, EXTRA_ORIGINS,
 *    TRUST_PROXY, MOCK_PUBLIC_URL, KASSA_APP_URL, EXPO_PUBLIC_API_URL). Start the services directly (not through turbo,
 *    which filters inline env vars) with those values.
 *
 * Flags: `--no-tunnel` runs only the proxy (PHONE_DIST overrides the export dir; used by `bun run demo:video`); `--print-env <host>` prints the env block for a host and exits.
 * Ctrl-C stops the proxy and the tunnel.
 */
import { existsSync, statSync } from "node:fs";
import { join, normalize } from "node:path";

const root = join(import.meta.dir, "..");
const args = process.argv.slice(2);
const num = (v: string | undefined, d: number) => (v && /^\d+$/.test(v) ? Number(v) : d);

const PORT = num(process.env.PHONE_PORT, 8080);
const API = `http://127.0.0.1:${num(process.env.API_PORT, 4000)}`;
const MOCK = `http://127.0.0.1:${num(process.env.MOCK_PORT, 4001)}`;
const WEB = `http://127.0.0.1:${num(process.env.WEB_PORT, 8081)}`;
const DIST = process.env.PHONE_DIST ?? join(root, "apps/mobile/dist");

/** Which upstream serves a path (Caddyfile routing). */
function upstreamFor(pathname: string): "api" | "mock" | "web" {
  if (pathname === "/api" || pathname.startsWith("/api/")) return "api";
  if (pathname === "/mock" || pathname.startsWith("/mock/")) return "mock";
  return "web";
}

/** The env block for a public host (no scheme). */
function envBlock(host: string): string {
  const origin = `https://${host}`;
  return [
    `# API (apps/api)`,
    `RP_ID=${host}`,
    `PUBLIC_ORIGIN=${origin}`,
    `EXTRA_ORIGINS=${origin}`,
    `TRUST_PROXY=true`,
    `# mock-world (apps/mock-world)`,
    `MOCK_PUBLIC_URL=${origin}`,
    `KASSA_APP_URL=${origin}`,
    `# web export (apps/mobile): bunx expo export -p web -c`,
    `EXPO_PUBLIC_API_URL=${origin}`,
    ``,
    `# Start (each in its own terminal, from the repo root):`,
    `cd apps/api && RP_ID=${host} PUBLIC_ORIGIN=${origin} EXTRA_ORIGINS=${origin} TRUST_PROXY=true DEMO_ENABLED=true ISSUING_PROVIDER=fake AGENT_MODE=REPLAY bun src/index.ts`,
    `cd apps/mock-world && MOCK_PUBLIC_URL=${origin} KASSA_APP_URL=${origin} DEMO_ENABLED=true ISSUING_PROVIDER=fake bun src/index.ts`,
    `cd apps/mobile && EXPO_PUBLIC_API_URL=${origin} EXPO_PUBLIC_DEMO_ADMIN_TOKEN=not-available-in-web-build bunx expo export -p web -c`,
  ].join("\n");
}

function printEnv(host: string): void {
  console.log(`\n========== Kassa on phones: https://${host} ==========\n${envBlock(host)}\n`);
  console.log(`Open https://${host} in Safari on each phone. Till: https://${host}/mock/shop/bud/till (M3).\n`);
}

const printEnvAt = args.indexOf("--print-env");
if (printEnvAt >= 0) {
  const host = args[printEnvAt + 1];
  if (!host || !/^[a-z0-9.-]+$/i.test(host)) {
    console.error("usage: bun run phone --print-env <host>");
    process.exit(2);
  }
  printEnv(host);
  process.exit(0);
}

// ---------- proxy ----------

const HOP_BY_HOP = ["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-connection", "te", "trailer"];

async function forward(req: Request, base: string, clientIp: string | null): Promise<Response> {
  const url = new URL(req.url);
  const headers = new Headers(req.headers);
  for (const h of HOP_BY_HOP) headers.delete(h);
  // The API trusts these only with TRUST_PROXY=true (printed above): per-client rate limits behind the tunnel.
  const prior = req.headers.get("x-forwarded-for");
  if (clientIp) headers.set("x-forwarded-for", prior ? `${prior}, ${clientIp}` : clientIp);
  headers.set("x-forwarded-host", url.host);
  headers.set("x-forwarded-proto", req.headers.get("x-forwarded-proto") ?? "https");
  try {
    const res = await fetch(`${base}${url.pathname}${url.search}`, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
      redirect: "manual",
      // @ts-expect-error Bun: stream request bodies without buffering
      duplex: "half",
    });
    const out = new Headers(res.headers);
    // fetch already decoded the body: the upstream encoding/length no longer apply.
    out.delete("content-encoding");
    out.delete("content-length");
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
  } catch (err) {
    return new Response(`upstream ${base} unreachable: ${(err as Error).message}\n`, { status: 502, headers: { "content-type": "text/plain" } });
  }
}

/** Static web export with an SPA fallback (Caddyfile try_files {path} {path}.html {path}/index.html /index.html). */
function serveDist(pathname: string): Response {
  const safe = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  for (const candidate of [safe, `${safe}.html`, join(safe, "index.html"), "/index.html"]) {
    const file = join(DIST, candidate);
    if (!file.startsWith(DIST)) continue;
    if (existsSync(file) && statSync(file).isFile()) return new Response(Bun.file(file));
  }
  return new Response("Not found\n", { status: 404 });
}

const useDist = existsSync(join(DIST, "index.html"));

const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req, srv) {
    const url = new URL(req.url);
    const ip = srv.requestIP(req)?.address ?? null;
    const up = upstreamFor(url.pathname);
    if (up === "api") return forward(req, API, ip);
    if (up === "mock") return forward(req, MOCK, ip);
    return useDist ? serveDist(url.pathname) : forward(req, WEB, ip);
  },
});
console.log(`proxy on http://127.0.0.1:${server.port}: /api -> ${API}, /mock -> ${MOCK}, else -> ${useDist ? DIST : WEB}`);

// ---------- tunnel ----------

let child: ReturnType<typeof Bun.spawn> | null = null;
function shutdown(code = 0): never {
  child?.kill();
  server.stop(true);
  process.exit(code);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

if (args.includes("--no-tunnel")) {
  console.log("--no-tunnel: proxy only. Ctrl-C to stop.");
} else {
  if (!Bun.which("cloudflared")) {
    console.error("cloudflared not found (brew install cloudflared), or run with --no-tunnel.");
    shutdown(1);
  }
  const named = process.env.CLOUDFLARED_TUNNEL;
  const fixedHost = process.env.PHONE_HOST;
  const target = `http://127.0.0.1:${server.port}`;
  if (named && fixedHost) {
    child = Bun.spawn(["cloudflared", "tunnel", "--no-autoupdate", "run", "--url", target, named], { stdout: "inherit", stderr: "inherit" });
    printEnv(fixedHost);
  } else {
    const bar = "!".repeat(78);
    console.warn(
      `\n${bar}\n QUICK TUNNEL: the hostname is random and changes on every restart.\n` +
        ` Passkeys are bound to RP_ID (= this host): after a restart every passkey made on the phones stops working.\n` +
        ` For a stable host set CLOUDFLARED_TUNNEL=<named tunnel> and PHONE_HOST=<its hostname>.\n${bar}\n`,
    );
    child = Bun.spawn(["cloudflared", "tunnel", "--no-autoupdate", "--url", target], { stdout: "inherit", stderr: "pipe" });
    // cloudflared logs the assigned https://<random>.trycloudflare.com URL on stderr.
    const decoder = new TextDecoder();
    let printed = false;
    void (async () => {
      for await (const chunk of child!.stderr as ReadableStream<Uint8Array>) {
        const text = decoder.decode(chunk);
        process.stderr.write(text);
        const m = !printed && /https:\/\/([a-z0-9-]+\.trycloudflare\.com)/.exec(text);
        if (m) {
          printed = true;
          printEnv(m[1]!);
        }
      }
    })();
  }
  void child.exited.then((code) => {
    console.error(`cloudflared exited (${code})`);
    shutdown(code ?? 1);
  });
}
