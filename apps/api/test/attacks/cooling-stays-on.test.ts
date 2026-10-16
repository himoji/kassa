/*
 * The attack suite runs with the 24 h waits on (the default): no attack test turns the demo switch off, and the agent
 * has no way to (no tool reaches demo/cooling.ts or POST /demo/cooling). The switch itself: test/core/demo-cooling.test.ts.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const TOUCHES = /demo\/cooling|demoCoolingOff|DEMO_COOLING_OFF/;

describe("attacks keep the 24 h waits on", () => {
  it("no attack test touches the demo switch", () => {
    const files = readdirSync(join(ROOT, "test/attacks")).filter((f) => f.endsWith(".ts") && f !== "cooling-stays-on.test.ts");
    expect(files.length).toBeGreaterThan(5);
    expect(files.filter((f) => TOUCHES.test(read(`test/attacks/${f}`)))).toEqual([]);
    expect(TOUCHES.test(read("test/helpers/attacks.ts"))).toBe(false);
  });

  it("no agent module can reach it", () => {
    const agent = readdirSync(join(ROOT, "src/modules/agent")).filter((f) => f.endsWith(".ts"));
    expect(agent.filter((f) => TOUCHES.test(read(`src/modules/agent/${f}`)))).toEqual([]);
  });
});
