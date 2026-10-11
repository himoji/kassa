import { describe, expect, it } from "@jest/globals";
import { ReasonCode } from "@kassa/shared";

import reasonCodes from "@/locales/en/reasonCodes.json";
import { i18next } from "@/lib/i18n";

const table = reasonCodes as Record<string, unknown>;
const codes = ReasonCode.options;

describe("reason code translations (en)", () => {
  it.each(codes)("%s has a non-empty label and text", (code) => {
    const entry = table[code];
    expect(typeof entry).toBe("object");
    expect(entry).not.toBeNull();
    const { label, text } = entry as { label?: unknown; text?: unknown };
    expect(typeof label).toBe("string");
    expect((label as string).length).toBeGreaterThan(0);
    expect(typeof text).toBe("string");
    expect((text as string).length).toBeGreaterThan(0);
  });

  it("has no keys that are not ReasonCode options", () => {
    const known = new Set<string>(codes);
    const extra = Object.keys(table).filter((key) => !known.has(key));
    expect(extra).toEqual([]);
  });

  it.each(codes)("%s label resolves through i18next", (code) => {
    const key = `${code}.label`;
    const resolved = String(i18next.t(`reasonCodes:${key}`));
    expect(resolved).not.toBe(key);
    expect(resolved).not.toBe(`reasonCodes:${key}`);
  });
});
