import { describe, expect, it } from "@jest/globals";

import { commitChunks } from "../commit-chunks";

const at = (min: number) => ({
  occurredAt: new Date(Date.UTC(2026, 9, 1) + min * 60_000).toISOString(),
});

describe("commitChunks", () => {
  it("keeps every row, in time order, in chunks of about the size", () => {
    const rows = Array.from({ length: 1000 }, (_, i) => at(i * 60)).reverse();
    const chunks = commitChunks(rows, 200);
    expect(chunks.flat()).toHaveLength(1000);
    expect(chunks.flat().map((r) => r.occurredAt)).toEqual(
      [...rows].reverse().map((r) => r.occurredAt)
    );
    expect(chunks.every((c) => c.length >= 200 || c === chunks.at(-1))).toBe(true);
  });

  it("never splits rows less than 20 minutes apart (they could be the same purchase)", () => {
    const rows = Array.from({ length: 300 }, (_, i) => at(i * 5));
    const chunks = commitChunks(rows, 100);
    for (let k = 1; k < chunks.length; k++) {
      const gap =
        Date.parse(chunks[k]![0]!.occurredAt) - Date.parse(chunks[k - 1]!.at(-1)!.occurredAt);
      expect(gap).toBeGreaterThanOrEqual(20 * 60_000);
    }
    expect(chunks).toHaveLength(1);
  });
});
