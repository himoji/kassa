import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { checkQrPayee, HANDOFF_NAME_THRESHOLD } from "../../src/modules/rails/handoff.ts";
import { FIXTURES_DIR, isValidIban, loadSanctions, looksLikeIban, normalizeIban, screenName } from "../../src/modules/screening/index.ts";
import { jaro, jaroWinkler } from "../../src/modules/screening/jaroWinkler.ts";
import { normalizeName } from "../../src/modules/screening/normalize.ts";
import { mod97 } from "../../src/modules/screening/iban.ts";

type SanctionsFixture = {
  testCases: { query: string; expectHitLogicalId: number | null; kind: string }[];
};

const fixture = JSON.parse(readFileSync(join(FIXTURES_DIR, "sanctions-sample.json"), "utf8")) as SanctionsFixture;

describe("jaro / jaroWinkler", () => {
  it("jaroWinkler(MARTHA, MARHTA) is about 0.9611", () => {
    expect(jaroWinkler("MARTHA", "MARHTA")).toBeCloseTo(0.9611, 3);
  });

  it("jaro(DIXON, DICKSONX) is about 0.7667", () => {
    expect(jaro("DIXON", "DICKSONX")).toBeCloseTo(0.7667, 3);
  });

  it("identical strings score 1", () => {
    expect(jaroWinkler("abc", "abc")).toBe(1);
  });

  it("an empty string against a non-empty one scores 0", () => {
    expect(jaroWinkler("", "abc")).toBe(0);
  });
});

describe("normalizeName", () => {
  it("transliterates Cyrillic to lowercase Latin", () => {
    expect(normalizeName("Иванов Сергей")).toBe("ivanov sergey");
  });

  it("strips legal suffixes, diacritics and extra whitespace when stripLegal is set", () => {
    expect(normalizeName("Café  Müller GmbH", { stripLegal: true })).toBe("cafe muller");
  });
});

describe("screenName against the sanctions sample fixture", () => {
  const list = loadSanctions();

  it("loads the sample list with at least 4 entries", () => {
    expect(list.length).toBeGreaterThanOrEqual(4);
  });

  it.each(fixture.testCases.map((tc) => [tc.kind, tc.query, tc.expectHitLogicalId] as const))(
    "%s: %j -> %s",
    (_kind, query, expectHitLogicalId) => {
      const result = screenName(query, list);
      if (typeof expectHitLogicalId === "number") {
        expect(result.hit).toBe(true);
        if (result.hit) expect(result.entryId).toBe(String(expectHitLogicalId));
      } else {
        expect(result.hit).toBe(false);
      }
    },
  );
});

describe("screenName edge cases", () => {
  it("an empty list never hits", () => {
    expect(screenName("anything", []).hit).toBe(false);
  });

  it("a missing fixtures directory yields an empty list without throwing", () => {
    expect(loadSanctions("/nonexistent/dir")).toEqual([]);
  });
});

describe("IBAN helpers", () => {
  it("accepts a valid Hungarian IBAN", () => {
    expect(isValidIban("HU75109183242065038100000003")).toBe(true);
  });

  it("accepts a valid IBAN written with spaces", () => {
    expect(isValidIban("HU75 1091 8324 2065 0381 0000 0003")).toBe(true);
  });

  it("rejects an IBAN with wrong check digits", () => {
    expect(isValidIban("HU76109183242065038100000003")).toBe(false);
  });

  it("accepts a valid GB IBAN", () => {
    expect(isValidIban("GB82WEST12345698765432")).toBe(true);
  });

  it("accepts a valid DE IBAN", () => {
    expect(isValidIban("DE89370400440532013000")).toBe(true);
  });

  it("rejects a DE IBAN with the wrong length", () => {
    expect(isValidIban("DE8937040044053201300")).toBe(false);
  });

  it("looksLikeIban rejects a plain digit string", () => {
    expect(looksLikeIban("12345678")).toBe(false);
  });

  it("normalizeIban strips spaces and upper-cases", () => {
    expect(normalizeIban("gb82 west 1234 5698 7654 32")).toBe("GB82WEST12345698765432");
  });

  it("mod97 of the ISO 13616 example numeric string is 1", () => {
    expect(mod97("3214282912345698765432161182")).toBe(1);
  });
});

describe("checkQrPayee and handoff threshold", () => {
  it("matches an identical payee name", () => {
    const r = checkQrPayee("Pudong Student Dormitory Office", "Pudong Student Dormitory Office");
    expect(r.match).toBe(true);
  });

  it("does not match an unrelated payee name", () => {
    const r = checkQrPayee("Quick Pay Trading Ltd.", "Pudong Student Dormitory Office");
    expect(r.match).toBe(false);
  });

  it("uses a 0.92 similarity threshold", () => {
    expect(HANDOFF_NAME_THRESHOLD).toBe(0.92);
  });
});
