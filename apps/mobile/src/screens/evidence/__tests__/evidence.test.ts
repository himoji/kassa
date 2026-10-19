import { describe, expect, it } from "@jest/globals";

import { attackList, moneyInDetail } from "../evidence-screen";

describe("attack evidence page", () => {
  it("lists every attack in id order", () => {
    const list = attackList();
    expect(list.length).toBe(16);
    expect(list[0]!.id).toBe("A1");
    expect(list.map((a) => Number(a.id.slice(1)))).toEqual(
      [...list.map((a) => Number(a.id.slice(1)))].sort((x, y) => x - y)
    );
  });

  it("each attack's chip is its worst case, and a passkey prompt is never shown as a refusal", () => {
    const rank = { REFUSED: 0, ASKED: 1, PAID: 2 } as const;
    for (const a of attackList()) {
      expect(a.guarded.cases.length).toBeGreaterThan(0);
      const worst = a.guarded.cases.reduce((w, c) => Math.max(w, rank[c.outcome]), 0);
      expect(rank[a.guarded.worst]).toBe(worst);
      for (const c of a.guarded.cases) {
        if (c.decision === "ASK" && c.outcome !== "REFUSED") expect(c.outcome).toBe("ASKED");
        if (c.outcome === "ASKED") expect(c.ifApproved?.note).toBeTruthy();
      }
      expect(a.tapConfirm).not.toBeNull();
    }
  });

  it("shows minor-unit amounts as money", () => {
    const money = (minor: number, ccy: string) => `${ccy} ${(minor / 100).toFixed(2)}`;
    expect(moneyInDetail("X received 45000000 HUF (minor units) via BANK_TRANSFER", money)).toBe(
      "X received HUF 450000.00 via BANK_TRANSFER"
    );
  });
});
