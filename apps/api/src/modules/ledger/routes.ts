import { LedgerResponse } from "@kassa/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";

import { requireUser, userIdOf } from "../auth/session.ts";
import { ledger } from "./index.ts";

/** GET /ledger?cursor — the caller's ledger entries, newest first (spec §8, Activity timeline). */
const routes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/ledger",
    {
      preHandler: requireUser,
      schema: {
        querystring: z.object({ cursor: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }),
        response: { 200: LedgerResponse },
      },
    },
    async (req) => {
      const page = await ledger.page(userIdOf(req), req.query.cursor ?? null, req.query.limit);
      return {
        items: page.items.map((e) => ({ seq: e.seq, ts: e.ts.toISOString(), type: e.type, payload: e.payload, prevHash: e.prevHash, hash: e.hash })),
        nextCursor: page.nextCursor,
      };
    },
  );
};

export default routes;
