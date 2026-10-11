/*
 * up / down / status / logs. `up` spawns the daemon detached (logs in .data/sim/logs/) with explicit env
 * overrides; process env beats .env in Bun, so the sim never reads or edits .env files and never touches
 * the dev database (its own PGlite dir under .data/sim/pglite). `down` stops the daemon gracefully, then
 * signals the daemon's whole process group (the daemon is spawned detached, so it leads its own group and its
 * mock-world child is a member: nothing survives even if the daemon hung or never wrote state.json), and checks
 * that every sim port is free. A test can set SIM_OWNER_PID: the daemon then stops itself when that process dies.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";

import { API_DIR, CONTROL_BASE, DAEMON_ENTRY, type DaemonState, ensureDir, FILES, MOCK_BASE, PORTS, readJson, readText, removeFile, SIM_DIR } from "./config.ts";
import { rawRequest } from "./http.ts";
import { fail } from "./out.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function alive(pid: number | null | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Any process left in process group `pgid` (kill(-pgid, 0), POSIX). */
export function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function portBusy(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ port, host: "127.0.0.1" });
    s.once("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.once("error", () => resolve(false));
    s.setTimeout(1000, () => {
      s.destroy();
      resolve(false);
    });
  });
}

async function portsReport() {
  return { api: await portBusy(PORTS.api), mock: await portBusy(PORTS.mock), control: await portBusy(PORTS.control) };
}

function daemonPid(): number | null {
  const s = readJson<DaemonState>(FILES.state);
  if (s?.daemonPid) return s.daemonPid;
  const t = readText(FILES.pid);
  return t && /^\d+$/.test(t) ? Number(t) : null;
}

export async function status() {
  const state = readJson<DaemonState>(FILES.state);
  const pid = daemonPid();
  const running = alive(pid);
  const ports = await portsReport();
  let clock: unknown = null;
  if (running && ports.api) {
    const r = await rawRequest(`http://127.0.0.1:${PORTS.api}`, "GET", "/api/demo/clock").catch(() => null);
    clock = r?.body ?? null;
  }
  return { running, daemonPid: pid, mockPid: state?.mockPid ?? null, mockAlive: alive(state?.mockPid), ready: Boolean(state), ports: PORTS, listening: ports, simDir: SIM_DIR, scheduler: state?.scheduler ?? null, clock };
}

export async function up(opts: { fresh: boolean; scheduler: boolean; liveFx: boolean }) {
  const pid = daemonPid();
  if (alive(pid)) {
    if (opts.fresh) fail("SIM_RUNNING", "sim is running; run `sim down` before `sim up --fresh`");
    return { started: false, alreadyRunning: true, ...(await status()) };
  }
  // Stale files from a crashed run.
  removeFile(FILES.state);
  removeFile(FILES.pid);
  const busy = await portsReport();
  if (busy.api || busy.mock || busy.control) {
    fail("PORT_IN_USE", "a sim port is already in use by another process (stop `bun run dev` or set SIM_*_PORT)", { ports: PORTS, listening: busy });
  }
  if (opts.fresh) {
    rmSync(FILES.db, { recursive: true, force: true });
    rmSync(FILES.personas, { recursive: true, force: true });
    removeFile(FILES.markers);
  }
  ensureDir(FILES.logs);
  ensureDir(FILES.personas);
  const token = randomBytes(32).toString("base64url");
  const demoToken = randomBytes(32).toString("base64url");
  ensureDir(SIM_DIR);
  writeFileSync(FILES.token, token, { mode: 0o600 });
  writeFileSync(FILES.demoToken, demoToken, { mode: 0o600 });

  const out = openSync(FILES.daemonLog, "a");
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  // Test runners leak these into children; the sim is a development-mode stack.
  delete env.VITEST;
  delete env.VITEST_WORKER_ID;
  delete env.VITEST_POOL_ID;
  Object.assign(env, {
    NODE_ENV: process.env.SIM_NODE_ENV ?? "development",
    DATABASE_URL: `pglite://${FILES.db}`,
    PORT: String(PORTS.api),
    HOST: "127.0.0.1",
    DEMO_ENABLED: "true",
    DEMO_ADMIN_TOKEN: demoToken,
    MOCK_WORLD_URL: MOCK_BASE,
    SCHEDULER_ENABLED: opts.scheduler ? "true" : "false",
    // Like production behind Caddy: the client IP comes from X-Forwarded-For (one simulated IP per persona).
    TRUST_PROXY: "true",
    RECORD: "",
  });
  const daemonArgs = [...(opts.scheduler ? ["--scheduler"] : []), ...(opts.liveFx ? ["--live-fx"] : [])];
  const child = spawn(process.execPath, [DAEMON_ENTRY, ...daemonArgs], {
    cwd: API_DIR,
    detached: true,
    stdio: ["ignore", out, out],
    env,
  });
  child.unref();
  closeSync(out);
  writeFileSync(FILES.pid, String(child.pid));

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (!alive(child.pid)) break;
    if (readJson<DaemonState>(FILES.state)) {
      const h = await rawRequest(CONTROL_BASE, "POST", "/health", { headers: { "x-sim-token": token }, body: {} }).catch(() => null);
      if (h && h.status === 200) return { started: true, fresh: opts.fresh, health: h.body, logs: FILES.daemonLog };
    }
    await sleep(300);
  }
  const tail = tailFile(FILES.daemonLog, 40);
  await down().catch(() => undefined);
  return fail("SIM_START_FAILED", "daemon did not become ready (see logs)", { logTail: tail });
}

export async function down() {
  const state = readJson<DaemonState>(FILES.state);
  const pid = daemonPid();
  const token = readText(FILES.token);
  let graceful = false;
  if (alive(pid) && token) {
    const r = await rawRequest(CONTROL_BASE, "POST", "/shutdown", { headers: { "x-sim-token": token }, body: {}, timeoutMs: 5000 }).catch(() => null);
    graceful = r?.status === 200;
    for (let i = 0; i < 50 && alive(pid); i++) await sleep(200);
  }
  // The daemon leads its process group (spawn detached → setsid), so pgid = daemon pid. Signal the group: that also
  // reaches mock-world when the daemon hung or died before writing state.json (only daemon.pid known).
  const pgid = pid ?? null;
  const signal = (sig: NodeJS.Signals): number[] => {
    const hit: number[] = [];
    if (pgid && groupAlive(pgid)) {
      try {
        process.kill(-pgid, sig);
        hit.push(-pgid);
      } catch {
        // group gone
      }
    }
    for (const p of [pid, state?.mockPid ?? null]) {
      if (!alive(p)) continue;
      try {
        process.kill(p!, sig);
        hit.push(p!);
      } catch {
        // gone
      }
    }
    return hit;
  };
  const anyAlive = () => alive(pid) || alive(state?.mockPid) || (pgid !== null && groupAlive(pgid));
  const killed = signal("SIGTERM");
  for (let i = 0; i < 25 && anyAlive(); i++) await sleep(200);
  if (anyAlive()) {
    // A stopped (SIGSTOP) or hung process never handles SIGTERM: SIGKILL the group.
    signal("SIGKILL");
    for (let i = 0; i < 25 && anyAlive(); i++) await sleep(200);
  }
  for (let i = 0; i < 25; i++) {
    const b = await portsReport();
    if (!b.api && !b.mock && !b.control) break;
    await sleep(200);
  }
  removeFile(FILES.state);
  removeFile(FILES.pid);
  removeFile(FILES.token);
  removeFile(FILES.demoToken);
  const listening = await portsReport();
  const portsFree = !listening.api && !listening.mock && !listening.control;
  return {
    stopped: true,
    graceful,
    signaled: killed,
    portsFree,
    listening,
    daemonAlive: alive(pid),
    mockAlive: alive(state?.mockPid),
    groupAlive: pgid !== null && groupAlive(pgid),
  };
}

export function tailFile(file: string, n: number): string[] {
  try {
    const size = statSync(file).size;
    const text = readFileSync(file, "utf8").slice(Math.max(0, size - 200_000));
    return text.split("\n").filter(Boolean).slice(-n);
  } catch {
    return [];
  }
}

export function logs(n: number) {
  return { daemon: tailFile(FILES.daemonLog, n), mockWorld: tailFile(FILES.mockLog, n), files: { daemon: FILES.daemonLog, mockWorld: FILES.mockLog } };
}
