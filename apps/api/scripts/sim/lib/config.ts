/*
 * Sim harness configuration: state directory, ports, and the small state files shared by the CLI and the
 * daemon. Everything lives under SIM_DIR (default <repo>/.data/sim, gitignored with the rest of .data/).
 * Ports and the directory are overridable so the Vitest smoke test can run beside a live sim.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
export const API_DIR = resolve(REPO_ROOT, "apps/api");
export const MOCK_WORLD_DIR = resolve(REPO_ROOT, "apps/mock-world");
export const DAEMON_ENTRY = fileURLToPath(new URL("../daemon.ts", import.meta.url));
export const CLI_ENTRY = fileURLToPath(new URL("../cli.ts", import.meta.url));
export const EVIDENCE_DIR = resolve(REPO_ROOT, process.env.SIM_EVIDENCE_DIR ?? "docs/evidence/sim");

function port(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isInteger(v) && v > 0 && v < 65536 ? v : fallback;
}

export const PORTS = {
  api: port("SIM_API_PORT", 4000),
  mock: port("SIM_MOCK_PORT", 4001),
  control: port("SIM_CONTROL_PORT", 4099),
};

export const SIM_DIR = resolve(REPO_ROOT, process.env.SIM_DIR ?? ".data/sim");

export const FILES = {
  pid: resolve(SIM_DIR, "daemon.pid"),
  state: resolve(SIM_DIR, "state.json"),
  token: resolve(SIM_DIR, "token"),
  demoToken: resolve(SIM_DIR, "demo-token"),
  markers: resolve(SIM_DIR, "markers.json"),
  personas: resolve(SIM_DIR, "personas"),
  logs: resolve(SIM_DIR, "logs"),
  daemonLog: resolve(SIM_DIR, "logs/daemon.log"),
  mockLog: resolve(SIM_DIR, "logs/mock-world.log"),
  files: resolve(SIM_DIR, "files"),
  db: resolve(SIM_DIR, "pglite"),
};

export const API_BASE = `http://127.0.0.1:${PORTS.api}`;
export const MOCK_BASE = `http://127.0.0.1:${PORTS.mock}`;
export const CONTROL_BASE = `http://127.0.0.1:${PORTS.control}`;
export const SIM_TOKEN_HEADER = "x-sim-token";

/** Written by the daemon once every listener is up. */
export type DaemonState = {
  daemonPid: number;
  mockPid: number | null;
  ports: typeof PORTS;
  startedAt: string;
  dbDir: string;
  origin: string;
  rpId: string;
  scheduler: boolean;
};

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

export function readJson<T>(file: string): T | null {
  try {
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : null;
  } catch {
    return null;
  }
}

export function writeJson(file: string, value: unknown, mode = 0o600): void {
  ensureDir(resolve(file, ".."));
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode });
}

export function readText(file: string): string | null {
  try {
    return existsSync(file) ? readFileSync(file, "utf8").trim() : null;
  } catch {
    return null;
  }
}

export function removeFile(file: string): void {
  rmSync(file, { force: true });
}
