import { describe, it, expect, vi } from "vitest";

import { addBusinessDays, daysBetween, withinOneBusinessDay } from "../../src/modules/fx/dates.ts";
import { parseNbkXml, RatesService } from "../../src/modules/fx/rates.ts";
import { applyBps, cmp, convertMinor, div, parseDecimal, rat, roundHalfUp, toDecimalString } from "../../src/modules/fx/rational.ts";

describe("rational", () => {
  it("parseDecimal reduces to a num/den fraction", () => {
    expect(parseDecimal("502.98")).toEqual(rat(25149n, 50n));
  });

  it("roundHalfUp rounds ties away from zero", () => {
    expect(roundHalfUp(rat(5n, 2n))).toBe(3n);
    expect(roundHalfUp(rat(-5n, 2n))).toBe(-3n);
    expect(roundHalfUp(rat(7n, 3n))).toBe(2n);
  });

  it("convertMinor converts minor units at a major-unit rate", () => {
    expect(convertMinor(10000, "EUR", "KZT", parseDecimal("612.40"))).toBe(6124000);
  });

  it("applyBps applies basis points half-up", () => {
    expect(applyBps(100000, 55)).toBe(550);
    expect(applyBps(1, 5000)).toBe(1);
  });

  it("toDecimalString trims and rounds to the requested places", () => {
    expect(toDecimalString(rat(1n, 3n), 4)).toBe("0.3333");
  });
});

describe("dates", () => {
  it("addBusinessDays skips weekends", () => {
    expect(addBusinessDays("2026-10-09", 1)).toBe("2026-10-12"); // Fri -> Mon
    expect(addBusinessDays("2026-10-12", -1)).toBe("2026-10-09"); // Mon -> Fri
  });

  it("withinOneBusinessDay accepts the adjacent business day around weekends", () => {
    expect(withinOneBusinessDay("2026-10-11", "2026-10-09")).toBe(true); // Sunday wants Friday
    expect(withinOneBusinessDay("2026-10-14", "2026-10-09")).toBe(false);
  });

  it("daysBetween counts whole days", () => {
    expect(daysBetween("2026-10-01", "2026-10-31")).toBe(30);
  });
});

describe("RatesService offline (STATIC_EXAMPLE fixture table)", () => {
  const svc = new RatesService({ offline: true });

  it("EUR -> KZT comes from the example table", async () => {
    const q = await svc.getRate("EUR", "KZT", "2026-10-27");
    expect(q.rateString).toBe("612.4");
    expect(q.source).toBe("STATIC_EXAMPLE");
    expect(q.rateDate).toBe("2026-10-27");
  });

  it("HUF -> KZT is the exact cross rate 612.40 / 392.50", async () => {
    const q = await svc.getRate("HUF", "KZT", "2026-10-27");
    expect(cmp(q.rate, div(parseDecimal("612.40"), parseDecimal("392.50")))).toBe(0);
  });

  it("KZT -> KZT is rate 1", async () => {
    const q = await svc.getRate("KZT", "KZT", "2026-10-27");
    expect(cmp(q.rate, rat(1n))).toBe(0);
  });

  it("rejects unsupported currencies", async () => {
    await expect(svc.getRate("XXX", "EUR", "2026-10-27")).rejects.toBeInstanceOf(RangeError);
  });
});

describe("RatesService online with stubbed fetch", () => {
  const FRANKFURTER_BODY = JSON.stringify({
    amount: 1.0,
    base: "EUR",
    date: "2026-10-09",
    rates: { CNY: 7.4992, HUF: 365.08, USD: 1.1206 },
  });
  const NBK_BODY =
    "<rates><date>09.10.2026</date>" +
    "<item><title>EUR</title><description>502.98</description><quant>1</quant></item>" +
    "<item><title>HUF</title><description>13.64</description><quant>10</quant></item>" +
    "<item><title>USD</title><description>447.73</description><quant>1</quant></item>" +
    "</rates>";

  function stubFetch(overrides: { frankfurterBody?: string; erApiStatus?: number } = {}) {
    const calls: string[] = [];
    const impl = async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push(url);
      if (url.includes("frankfurter")) return new Response(overrides.frankfurterBody ?? FRANKFURTER_BODY);
      if (url.includes("nationalbank.kz")) return new Response(NBK_BODY);
      if (url.includes("er-api")) return new Response("", { status: overrides.erApiStatus ?? 200 });
      return new Response("", { status: 404 });
    };
    return { fetch: impl as unknown as typeof fetch, calls };
  }

  it("EUR -> USD uses the ECB/Frankfurter table", async () => {
    const { fetch } = stubFetch();
    const svc = new RatesService({ fetch, offline: false });
    const q = await svc.getRate("EUR", "USD", "2026-10-09");
    expect(q.rateString).toBe("1.1206");
    expect(q.source).toBe("ECB_FRANKFURTER");
  });

  it("HUF -> KZT uses the NBK table", async () => {
    const { fetch } = stubFetch();
    const svc = new RatesService({ fetch, offline: false });
    const q = await svc.getRate("HUF", "KZT", "2026-10-09");
    expect(q.rateString).toBe("1.364");
    expect(q.source).toBe("NBK");
  });

  it("a repeat call for the same date and source is served from cache", async () => {
    const { fetch, calls } = stubFetch();
    const svc = new RatesService({ fetch, offline: false });
    await svc.getRate("HUF", "KZT", "2026-10-09");
    await svc.getRate("HUF", "KZT", "2026-10-09");
    expect(calls.filter((u) => u.includes("nationalbank.kz"))).toHaveLength(1);
  });

  it("falls back to STATIC_EXAMPLE when the rate date is outside ±1 business day and the fallback API fails", async () => {
    const { fetch } = stubFetch({
      frankfurterBody: JSON.stringify({ amount: 1.0, base: "EUR", date: "2026-10-01", rates: { CNY: 7.4992, HUF: 365.08, USD: 1.1206 } }),
      erApiStatus: 500,
    });
    const svc = new RatesService({ fetch, offline: false });
    const q = await svc.getRate("EUR", "USD", "2026-10-09");
    expect(q.source).toBe("STATIC_EXAMPLE");
  });

  it("does not call the network at all when offline", async () => {
    const spy = vi.fn(async () => new Response(""));
    const svc = new RatesService({ fetch: spy as unknown as typeof fetch, offline: true });
    await svc.getRate("EUR", "USD", "2026-10-09");
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("parseNbkXml", () => {
  it("parses the date and per-unit KZT rates (quant-adjusted)", () => {
    const xml =
      "<rates><date>09.10.2026</date>" +
      "<item><title>EUR</title><description>502.98</description><quant>1</quant></item>" +
      "<item><title>HUF</title><description>13.64</description><quant>10</quant></item>" +
      "</rates>";
    const t = parseNbkXml(xml, "2000-01-01");
    expect(t?.date).toBe("2026-10-09");
    expect(cmp(t!.perUnit.get("HUF")!, parseDecimal("1.364"))).toBe(0);
  });
});
