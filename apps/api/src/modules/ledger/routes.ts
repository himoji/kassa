import { LedgerResponse } from "@kassa/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";

import { userIdOf } from "../auth/session.ts";
import { viewLedgerPayload } from "../privacy/keys.ts";
import { ledger } from "./index.ts";

/** GET /ledger?cursor — the caller's ledger entries, newest first (spec §8, Activity timeline). */
const routes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/ledger",
    {
      schema: {
        querystring: z.object({ cursor: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }),
        response: { 200: LedgerResponse },
      },
    },
    async (req) => {
      const page = await ledger.page(userIdOf(req), req.query.cursor ?? null, req.query.limit);
      return {
        // Sealed personal fields (`pii`) are decrypted for their owner; the hash covers the stored ciphertext.
        items: await Promise.all(
          page.items.map(async (e) => ({ seq: e.seq, ts: e.ts.toISOString(), type: e.type, payload: await viewLedgerPayload(e.payload), prevHash: e.prevHash, hash: e.hash })),
        ),
        nextCursor: page.nextCursor,
      };
    },
  );
};

export default routes;
