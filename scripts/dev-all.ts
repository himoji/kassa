#!/usr/bin/env bun
/**
 * `bun run dev:all` - the whole local stack (API, mock-world, mobile web) reachable from a phone over one HTTPS origin.
 *
 *   bun run dev:all                 tunnel + :8080 proxy + `turbo run` of api/mock-world/mobile web, prints URL + QR
 *   bun run dev:all --no-tunnel     localhost only: plain `turbo run dev` with the current env
 *
 * Tunnel: a named tunnel when CLOUDFLARED_TUNNEL and PHONE_HOST are set (stable host, passkeys survive restarts),
 * otherwise a quick tunnel whose host changes every run. Dev sign-in stays off on a tunnel unless DEV_LOGIN=true is set.
 * The web app on the tunnel calls its own origin (/api through the proxy); localhost tabs call the API directly.
 * The derived env (PUBLIC_ORIGIN, EXTRA_ORIGINS, RP_ID, EXPO_PUBLIC_API_URL, ...) is written to the gitignored
 * `.env.dev-runtime` and merged into turbo's environment (declared in globalPassThroughEnv in turbo.json).
 * cloudflared logs go to `.data/cloudflared.log`, shown with the URL + QR in turbo's `//#dev:tunnel` pane.
 * Ctrl-C / SIGTERM stops turbo, the proxy and the tunnel.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import QRCode from "qrcode";
import { TUNNEL_LOG } from "./dev-tunnel.ts";
import { startProxy } from "./lib/proxy.ts";
import { startTunnel, type Tunnel } from "./lib/tunnel.ts";

const root = join(import.meta.dir, "..");
const noTunnel = process.argv.slice(2).includes("--no-tunnel");
const num = (v: string | undefined, d: number) => (v && /^\d+$/.test(v) ? Number(v) : d);

const children: { stop(): void }[] = [];
let turbo: ReturnType<typeof Bun.spawn> | null = null;
let closing = false;
function shutdown(code = 0): never {
  if (!closing) {
    closing = true;
    turbo?.kill("SIGTERM");
    for (const c of children.reverse()) c.stop();
  }
  process.exit(code);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

function runTurbo(args: string[], env: Record<string, string | undefined>): void {
  turbo = Bun.spawn(["bunx", "turbo", "run", ...args], { cwd: root, env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  void turbo.exited.then((code) => shutdown(code ?? 0));
}

if (noTunnel) {
  console.log("--no-tunnel: localhost only (turbo run dev).");
  runTurbo(["dev"], process.env);
} else {
  const PORT = num(process.env.PHONE_PORT, 8080);
  const proxy = startProxy({
    port: PORT,
    api: `http://127.0.0.1:${num(process.env.API_PORT, 4000)}`,
    mock: `http://127.0.0.1:${num(process.env.MOCK_PORT, 4001)}`,
    web: `http://127.0.0.1:${num(process.env.WEB_PORT, 8081)}`,
    dist: process.env.PHONE_DIST ?? join(root, "apps/mobile/dist"),
  });
  children.push(proxy);
  console.log(`proxy on http://127.0.0.1:${proxy.port} -> ${proxy.webTarget}`);

  const name = process.env.CLOUDFLARED_TUNNEL;
  const hostname = process.env.PHONE_HOST;
  const stable = Boolean(name && hostname);
  if (!stable) {
    console.warn(
      "\nQuick tunnel: the host changes every run, so passkeys will not survive a restart.\n" +
        "Dev sign-in is off: anyone with the tunnel URL could approve payments with it. Opt in with DEV_LOGIN=true.\n" +
        "For a stable host set CLOUDFLARED_TUNNEL=<named tunnel> and PHONE_HOST=<hostname>.\n",
    );
  }

  let tunnel: Tunnel;
  try {
    tunnel = await startTunnel({
      port: proxy.port,
      name,
      hostname,
      // Into a file, not the terminal: turbo's TUI owns it next. The //#dev:tunnel pane follows the file.
      logFile: TUNNEL_LOG,
      onExit: (code) => {
        console.error(`cloudflared exited (${code})`);
        shutdown(code ?? 1);
      },
    });
  } catch (err) {
    console.error((err as Error).message);
    shutdown(1);
  }
  children.push(tunnel);

  // The tunnel plus this machine's own tabs (Expo opens the web server on localhost, the proxy listens on PORT):
  // they call the API cross-origin, so CORS and the session CSRF check must accept them.
  const webPort = num(process.env.WEB_PORT, 8081);
  const local = [webPort, proxy.port].flatMap((p) => [`http://localhost:${p}`, `http://127.0.0.1:${p}`]);
  const runtime: Record<string, string> = {
    PUBLIC_ORIGIN: tunnel.url,
    EXTRA_ORIGINS: [tunnel.url, ...local].join(","),
    RP_ID: tunnel.host,
    // Same value env:setup writes to apps/mobile/.env (which wins over this in Expo dev anyway): localhost tabs call
    // the API directly; pages on the tunnel ignore a loopback API URL and use their own origin (src/api/config.ts).
    EXPO_PUBLIC_API_URL: `http://localhost:${num(process.env.API_PORT, 4000)}`,
    // Not in any .env, so it reaches the web app as is: the web app then ignores EXPO_PUBLIC_API_URL, which a .env
    // can pin to an old tunnel host (src/api/config.ts).
    EXPO_PUBLIC_DEV_ALL_API_URL: `http://localhost:${num(process.env.API_PORT, 4000)}`,
    TRUST_PROXY: "true",
    MOCK_PUBLIC_URL: tunnel.url,
    KASSA_APP_URL: tunnel.url,
    DEMO_ENABLED: process.env.DEMO_ENABLED ?? "true",
    // Dev sign-in (a server-held test passkey) over a public tunnel lets anyone with the URL approve payments as the
    // dev user, so it is off unless asked for: DEV_LOGIN=true bun run dev:all (SECURITY.md §7.0).
    ...(process.env.DEV_LOGIN === "true" ? { DEV_LOGIN: "true" } : {}),
  };
  writeFileSync(
    join(root, ".env.dev-runtime"),
    `# Generated by \`bun run dev:all\`; gitignored, rewritten on every run.\n${Object.entries(runtime).map(([k, v]) => `${k}=${v}`).join("\n")}\n`,
  );

  console.log(`\nKassa on phones: ${tunnel.url}  (${tunnel.kind} tunnel)\n`);
  console.log(await QRCode.toString(tunnel.url, { type: "terminal", small: true }));

  // api + mock-world dev, the mobile web server the proxy forwards to (apps/mobile "web" task), and the tunnel pane
  // (URL, QR code, cloudflared log; the URL and QR printed above are cleared once the TUI starts).
  runTurbo(["@kassa/api#dev", "@kassa/mock-world#dev", "@kassa/mobile#web", "//#dev:tunnel"], { ...process.env, ...runtime });
}
