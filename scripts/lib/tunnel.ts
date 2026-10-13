/**
 * Cloudflare tunnel helper shared by `bun run phone` and `bun run dev:all`.
 *  - `name` + `hostname` given: `cloudflared tunnel run <name>`, a named tunnel with a stable hostname (route it once with
 *    `cloudflared tunnel route dns <name> <host>`). RP_ID stays the same across restarts, so passkeys keep working.
 *  - otherwise a quick tunnel (`cloudflared tunnel --url ...`) on a random trycloudflare.com host that changes per run.
 */
export interface TunnelOptions {
  port: number;
  /** Named tunnel (requires hostname). */
  name?: string;
  hostname?: string;
  /** Called when cloudflared exits on its own (not after stop()). */
  onExit?: (code: number | null) => void;
  /** Max ms to wait for the quick-tunnel URL / named-tunnel connection. */
  timeoutMs?: number;
}

export interface Tunnel {
  url: string;
  host: string;
  kind: "quick" | "named";
  stop(): void;
}

type Child = ReturnType<typeof Bun.spawn>;

/** Reads a child's stderr, mirrors it to ours, and calls `onText` for each chunk. */
function pumpStderr(child: Child, onText: (text: string) => void): void {
  const decoder = new TextDecoder();
  void (async () => {
    for await (const chunk of child.stderr as ReadableStream<Uint8Array>) {
      const text = decoder.decode(chunk);
      process.stderr.write(text);
      onText(text);
    }
  })();
}

export async function startTunnel(opts: TunnelOptions): Promise<Tunnel> {
  if (!Bun.which("cloudflared")) throw new Error("cloudflared not found (brew install cloudflared), or run with --no-tunnel.");
  const target = `http://127.0.0.1:${opts.port}`;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const named = Boolean(opts.name && opts.hostname);

  const child: Child = Bun.spawn(
    named
      ? ["cloudflared", "tunnel", "--no-autoupdate", "run", "--url", target, opts.name!]
      : ["cloudflared", "tunnel", "--no-autoupdate", "--url", target],
    { stdout: "inherit", stderr: "pipe" },
  );
  let stopped = false;
  const stop = () => {
    stopped = true;
    child.kill();
  };
  void child.exited.then((code) => {
    if (!stopped) opts.onExit?.(code);
  });

  const host = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      stop();
      reject(new Error(`cloudflared did not become ready within ${timeoutMs / 1000}s`));
    }, timeoutMs);
    const done = (h: string) => {
      clearTimeout(timer);
      resolve(h);
    };
    void child.exited.then((code) => {
      clearTimeout(timer);
      reject(new Error(`cloudflared exited early (${code})`));
    });
    let settled = false;
    let urlHost: string | null = null;
    pumpStderr(child, (text) => {
      if (settled) return;
      if (named) {
        // Named tunnels log "Registered tunnel connection" once an edge connection is up.
        if (/Registered tunnel connection/i.test(text)) {
          settled = true;
          done(opts.hostname!);
        }
      } else {
        // cloudflared logs the assigned https://<random>.trycloudflare.com URL on stderr.
        const m = urlHost === null ? /https:\/\/([a-z0-9-]+\.trycloudflare\.com)/.exec(text) : null;
        if (m) {
          urlHost = m[1]!;
          settled = true;
          done(urlHost);
        }
      }
    });
  });

  return { url: `https://${host}`, host, kind: named ? "named" : "quick", stop };
}
