import { SupportedCurrency } from "@kassa/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";

import { clock, isoDate } from "../clock/index.ts";
import { rates } from "./rates.ts";

/*
 * GET /fx/rates?base=EUR&date=YYYY-MM-DD — mid rates quoted ECB style (1 base = rates[X] X) as decimal
 * strings, for mock-world's quotes (Track D contract). Public, read-only: published reference rates.
 * `sources` labels where each rate came from (NBK / ECB_FRANKFURTER / FALLBACK_ER_API / STATIC_EXAMPLE).
 */

export const FxRatesResponse = z.object({
  base: SupportedCurrency,
  date: z.iso.date(),
  rates: z.record(z.string(), z.string()),
  sources: z.record(z.string(), z.string()),
});

const fxRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/fx/rates",
    { schema: { querystring: z.object({ base: SupportedCurrency.default("EUR"), date: z.iso.date().optional() }), response: { 200: FxRatesResponse } } },
    async (req) => {
      const date = req.query.date ?? isoDate(clock.now());
      const out: Record<string, string> = {};
      const sources: Record<string, string> = {};
      let rateDate = date;
      for (const c of SupportedCurrency.options) {
        const q = await rates().getRate(req.query.base, c, date);
        out[c] = q.rateString;
        sources[c] = q.source;
        if (c !== req.query.base) rateDate = q.rateDate;
      }
      return { base: req.query.base, date: rateDate, rates: out, sources };
    },
  );
};

export default fxRoutes;
