import { readFileSync } from "node:fs";

import { describe, it, expect } from "vitest";

import { lookupMerchant } from "../../src/modules/capture/categorize.ts";
import type { MerchantDictionary } from "../../src/modules/capture/categorize.ts";
import { BUCKET_MS, bucketOf, dedupeCandidates, dedupeKey } from "../../src/modules/capture/dedupe.ts";
import type { DedupeFields } from "../../src/modules/capture/dedupe.ts";
import { normalizeMerchant } from "../../src/modules/capture/normalize.ts";

const merchants = JSON.parse(
  readFileSync(new URL("../../../../fixtures/merchants.json", import.meta.url), "utf8"),
) as MerchantDictionary;

describe("normalizeMerchant", () => {
  it.each([
    ["FRESH MARKET HALL BP", "fresh market hall"],
    ["NOODLE BAR BUDAPEST", "noodle bar"],
    ["VALUE MART 0412 BUDAPEST", "value mart"],
    ["CORNER GROCERY KFT", "corner grocery"],
    ["FRESH MARKET HALL BP, BUDAPEST, HU", "fresh market hall"],
    ["便利店(示例)", "便利店(示例)"],
    ["示例科技有限公司", "示例科技"],
    ["Bean There Cafe.", "bean there cafe"],
    ["PIZZA SHOP BUDAPEST HU", "pizza shop"],
  ])("%s → %s", (raw, expected) => {
    expect(normalizeMerchant(raw)).toBe(expected);
  });
});

describe("merchant aliases resolve through normalizeMerchant + lookupMerchant", () => {
  const aliasCases = merchants.merchants.flatMap((m) =>
    m.aliases.map((alias): [string, string] => [alias, m.merchantNorm]),
  );

  it("fixture has aliases to check", () => {
    expect(aliasCases.length).toBeGreaterThan(0);
  });

  it.each(aliasCases)("alias %s → merchantNorm %s", (alias, merchantNorm) => {
    expect(lookupMerchant(normalizeMerchant(alias))?.merchantNorm).toBe(merchantNorm);
  });
});

describe("dedupe", () => {
  const base: DedupeFields = {
    userId: "u",
    amountMinor: 476000,
    currency: "HUF",
    merchantNorm: "fresh market hall",
    occurredAt: new Date("2026-10-26T18:50:00Z"),
  };

  it("BUCKET_MS is 10 minutes", () => {
    expect(BUCKET_MS).toBe(600000);
  });

  it("dedupeKey has the spec format userId|amountMinor|currency|merchantNorm|bucket", () => {
    expect(dedupeKey(base)).toBe(
      `u|476000|HUF|fresh market hall|${Math.floor(Date.parse("2026-10-26T18:50:00Z") / 600000)}`,
    );
  });

  it("bucketOf floors epoch ms to 10-minute buckets", () => {
    expect(bucketOf(new Date("2026-10-26T18:59:59Z"))).toBe(bucketOf(new Date("2026-10-26T18:50:00Z")));
    expect(bucketOf(new Date("2026-10-26T19:00:00Z"))).toBe(bucketOf(new Date("2026-10-26T18:50:00Z")) + 1);
  });

  it("2 minutes into a bucket: the neighbour is the previous bucket", () => {
    const at = new Date("2026-10-26T18:42:00Z");
    const b = bucketOf(at);
    const [own, neighbour] = dedupeCandidates({ ...base, occurredAt: at });
    expect(own).toBe(dedupeKey({ ...base, occurredAt: at }, b));
    expect(neighbour).toBe(dedupeKey({ ...base, occurredAt: at }, b - 1));
  });

  it("8 minutes into a bucket: the neighbour is the next bucket", () => {
    const at = new Date("2026-10-26T18:48:00Z");
    const b = bucketOf(at);
    const [own, neighbour] = dedupeCandidates({ ...base, occurredAt: at });
    expect(own).toBe(dedupeKey({ ...base, occurredAt: at }, b));
    expect(neighbour).toBe(dedupeKey({ ...base, occurredAt: at }, b + 1));
  });

  it("two sightings 4 minutes apart across a bucket boundary share a candidate key", () => {
    const a = dedupeCandidates({ ...base, occurredAt: new Date("2026-10-26T18:58:00Z") });
    const b = dedupeCandidates({ ...base, occurredAt: new Date("2026-10-26T19:02:00Z") });
    const shared = a.filter((k) => b.includes(k));
    expect(shared.length).toBeGreaterThan(0);
  });

  it("two sightings 25 minutes apart share no candidate key", () => {
    const a = dedupeCandidates({ ...base, occurredAt: new Date("2026-10-26T18:00:00Z") });
    const b = dedupeCandidates({ ...base, occurredAt: new Date("2026-10-26T18:25:00Z") });
    expect(a.filter((k) => b.includes(k))).toEqual([]);
  });
});
