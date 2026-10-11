/*
 * Y7: the sim leaves no orphan processes (security REPORT: 3 orphaned daemon trees, parent PID 1, after sim-smoke).
 * Two leak paths, both reproduced here through real processes on their own ports / state directory:
 *  1. `sim down` with an unresponsive daemon and no state.json (startup timeout / crash before ready): the old
 *     `down` SIGKILLed the daemon pid only, so its mock-world child survived. `down` now signals the daemon's
 *     whole process group (the daemon is spawned detached, so it leads its own group).
 *  2. The owner of a test sim (the vitest worker) is killed before `afterAll` can run `sim down` (outer command
 *     timeout, Ctrl-C): with SIM_OWNER_PID set, the daemon shuts itself down when that process is gone.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const REPO = fileURLToPath(new URL("../../../../", import.meta.url));
const CLI = fileURLToPath(new URL("../../scripts/sim/cli.ts", import.meta.url));
const DIR = mkdtempSync(join(tmpdir(), "kassa-sim-down-"));
const PORTS = { SIM_API_PORT: "4193", SIM_MOCK_PORT: "4194", SIM_CONTROL_PORT: "4195" };

type Out = { code: number; json: Record<string, unknown> };

function sim(extraEnv: Record<string, string>, ...args: string[]): Out {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  Object.assign(env, PORTS, { SIM_DIR: DIR, SIM_EVIDENCE_DIR: join(DIR, "evidence"), SIM_OWNER_PID: String(process.pid) }, extraEnv);
  const r = spawnSync("bun", [CLI, ...args], { cwd: REPO, env, encoding: "utf8", timeout: 150_000 });
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(r.stdout) as Record<string, unknown>;
  } catch {
    json = { unparsed: r.stdout, stderr: r.stderr };
  }
  return { code: r.status ?? -1, json };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Every live process whose process group is `pgid` (ps -A -o pid=,pgid=). */
function groupMembers(pgid: number): number[] {
  const r = spawnSync("ps", ["-A", "-o", "pid=,pgid="], { encoding: "utf8" });
  return r.stdout
    .split("\n")
    .map((l) => l.trim().split(/\s+/).map(Number))
    .filter(([pid, g]) => g === pgid && pid !== undefined && !Number.isNaN(pid))
    .map(([pid]) => pid!);
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ port, host: "127.0.0.1" });
    s.once("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.once("error", () => resolve(false));
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(cond: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return true;
    await sleep(250);
  }
  return cond();
}

function state(): { daemonPid: number; mockPid: number } {
  return JSON.parse(readFileSync(join(DIR, "state.json"), "utf8")) as { daemonPid: number; mockPid: number };
}

const killAll = (pids: number[]) => {
  for (const p of pids) {
    try {
      process.kill(p, "SIGKILL");
    } catch {
      // gone
    }
  }
};

afterAll(() => {
  sim({}, "down");
  rmSync(DIR, { recursive: true, force: true });
});

describe("sim down / orphan processes (Y7)", () => {
  it("down kills the whole daemon tree even when the daemon hangs and state.json is gone", async () => {
    const up = sim({}, "up", "--fresh");
    expect(up.code, JSON.stringify(up.json)).toBe(0);
    const { daemonPid, mockPid } = state();
    expect(groupMembers(daemonPid)).toEqual(expect.arrayContaining([daemonPid, mockPid]));
    try {
      // Hung daemon (no /shutdown, SIGTERM stays pending) and no state.json: only daemon.pid is left.
      process.kill(daemonPid, "SIGSTOP");
      rmSync(join(DIR, "state.json"));
      const down = sim({}, "down");
      expect(down.code, JSON.stringify(down.json)).toBe(0);
      expect(await waitUntil(() => !alive(mockPid) && !alive(daemonPid), 10_000)).toBe(true);
      expect(groupMembers(daemonPid)).toEqual([]);
      expect(down.json.portsFree).toBe(true);
    } finally {
      killAll([daemonPid, mockPid]);
    }
  }, 240_000);

  it("a test sim stops by itself when its owner process dies before afterAll", async () => {
    const owner = spawn("sleep", ["300"], { stdio: "ignore" });
    // Reuses the database the first test migrated and seeded (no --fresh): a much cheaper start.
    const up = sim({ SIM_OWNER_PID: String(owner.pid) }, "up");
    expect(up.code, JSON.stringify(up.json)).toBe(0);
    const { daemonPid, mockPid } = state();
    try {
      owner.kill("SIGKILL");
      expect(await waitUntil(() => !alive(daemonPid) && !alive(mockPid), 15_000)).toBe(true);
      expect(groupMembers(daemonPid)).toEqual([]);
      for (const p of Object.values(PORTS)) expect(await portOpen(Number(p))).toBe(false);
    } finally {
      killAll([daemonPid, mockPid]);
    }
  }, 240_000);
});
