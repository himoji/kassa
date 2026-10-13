/**
 * Single-origin dev proxy (same routing as the repo Caddyfile), shared by `bun run phone` and `bun run dev:all`:
 *   /api*  -> API       /mock* -> mock-world
 *   else   -> the web export in `dist` (SPA fallback to index.html) if it exists, otherwise the Expo web server.
 */
import { existsSync, statSync } from "node:fs";
import { join, normalize } from "node:path";

export interface ProxyOptions {
  port: number;
  api: string;
  mock: string;
  web: string;
  /** Static web export directory; used only when it contains index.html. */
  dist: string;
}

export interface Proxy {
  port: number;
  /** What non-api/mock paths are served from (for logging). */
  webTarget: string;
  stop(): void;
}

/** Which upstream serves a path (Caddyfile routing). */
export function upstreamFor(pathname: string): "api" | "mock" | "web" {
  if (pathname === "/api" || pathname.startsWith("/api/")) return "api";
  if (pathname === "/mock" || pathname.startsWith("/mock/")) return "mock";
  return "web";
}

const HOP_BY_HOP = ["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-connection", "te", "trailer"];

async function forward(req: Request, base: string, clientIp: string | null): Promise<Response> {
  const url = new URL(req.url);
  const headers = new Headers(req.headers);
  for (const h of HOP_BY_HOP) headers.delete(h);
  // The API trusts these only with TRUST_PROXY=true: per-client rate limits behind the tunnel.
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
function serveDist(dist: string, pathname: string): Response {
  const safe = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  for (const candidate of [safe, `${safe}.html`, join(safe, "index.html"), "/index.html"]) {
    const file = join(dist, candidate);
    if (!file.startsWith(dist)) continue;
    if (existsSync(file) && statSync(file).isFile()) return new Response(Bun.file(file));
  }
  return new Response("Not found\n", { status: 404 });
}

export function startProxy(opts: ProxyOptions): Proxy {
  const useDist = existsSync(join(opts.dist, "index.html"));
  const server = Bun.serve({
    port: opts.port,
    hostname: "127.0.0.1",
    async fetch(req, srv) {
      const url = new URL(req.url);
      const ip = srv.requestIP(req)?.address ?? null;
      const up = upstreamFor(url.pathname);
      if (up === "api") return forward(req, opts.api, ip);
      if (up === "mock") return forward(req, opts.mock, ip);
      return useDist ? serveDist(opts.dist, url.pathname) : forward(req, opts.web, ip);
    },
  });
  return {
    port: server.port ?? opts.port,
    webTarget: useDist ? opts.dist : opts.web,
    stop: () => void server.stop(true),
  };
}
