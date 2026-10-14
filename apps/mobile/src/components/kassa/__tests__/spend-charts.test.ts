import { describe, expect, it } from "@jest/globals";

import { chartMax } from "../spend-charts";

describe("chartMax", () => {
  it("scales to the biggest day when no day dwarfs the rest", () => {
    expect(chartMax([0, 400, 900, 600])).toBe(900);
    expect(chartMax([])).toBe(1);
    expect(chartMax([0, 0])).toBe(1);
  });

  it("follows the second-biggest day when one day is over three times it (rent on the 1st)", () => {
    expect(chartMax([28_000_000, 600_000, 450_000, 0])).toBe(900_000);
  });
});
