import { describe, expect, it } from "@jest/globals";

import {
  DEMO_PERSONAS,
  demoClaimFor,
  parseDemoPersona,
  visibleDemoPersonas,
} from "@/lib/demo-personas";
import { en } from "@/locales/en";

describe("demo personas", () => {
  it("accepts allow-listed ?persona= keys", () => {
    expect(parseDemoPersona("pizzeria-bud")).toBe("pizzeria-bud");
    expect(parseDemoPersona(["li-wei-cn", "dana"])).toBe("li-wei-cn");
  });

  it("falls back to Dana for missing or unknown keys", () => {
    expect(parseDemoPersona(undefined)).toBe("dana");
    expect(parseDemoPersona("")).toBe("dana");
    expect(parseDemoPersona("admin")).toBe("dana");
    expect(parseDemoPersona("../li-wei")).toBe("dana");
  });

  it("claims Dana with true and other personas by key", () => {
    expect(demoClaimFor("dana")).toBe(true);
    expect(demoClaimFor("li-wei")).toBe("li-wei");
  });

  it("has a label and a display name for every persona", () => {
    const personas = en.auth.welcome.personas as Record<string, { label: string; name: string }>;
    for (const p of DEMO_PERSONAS) {
      expect(personas[p]?.label).toBeTruthy();
      expect(personas[p]?.name).toBeTruthy();
    }
  });

  it("hides the business personas unless asked for or opened by link", () => {
    expect(visibleDemoPersonas("dana", false)).toEqual(["dana", "li-wei", "li-wei-cn"]);
    expect(visibleDemoPersonas("pizzeria-bud", false)).toEqual([
      "dana",
      "li-wei",
      "li-wei-cn",
      "pizzeria-bud",
    ]);
    expect(visibleDemoPersonas("dana", true)).toEqual([...DEMO_PERSONAS]);
  });
});
