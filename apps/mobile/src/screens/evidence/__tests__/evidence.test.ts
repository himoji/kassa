import { describe, expect, it } from "@jest/globals";

import { attackList, moneyInDetail } from "../evidence-screen";

describe("attack evidence page", () => {
  it("lists every attack in id order, none paid with the guards", () => {
    const list = attackList();
    expect(list.length).toBe(16);
    expect(list[0]!.id).toBe("A1");
    expect(list.map((a) => Number(a.id.slice(1)))).toEqual(
      [...list.map((a) => Number(a.id.slice(1)))].sort((x, y) => x - y)
    );
    expect(list.every((a) => !a.guarded.paid)).toBe(true);
  });

  it("shows minor-unit amounts as money", () => {
    const money = (minor: number, ccy: string) => `${ccy} ${(minor / 100).toFixed(2)}`;
    expect(moneyInDetail("X received 45000000 HUF (minor units) via BANK_TRANSFER", money)).toBe(
      "X received HUF 450000.00 via BANK_TRANSFER"
    );
  });
});
