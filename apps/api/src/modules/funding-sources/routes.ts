import { ConfirmLinkRequest, SendQuoteResponse, FundingSourceDto, FundingSourcesResponse, LinkBankRequest, LinkCardRequest, StartLinkResponse } from "@kassa/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";

import { requireUser, userIdOf } from "../auth/session.ts";
import { confirmLink, removeFundingSource, startBankLink, startCardLink } from "./service.ts";
import { sendQuote, SendQuoteQuery } from "./quote.ts";
import { listFundingSources, toFundingSourceDto } from "./store.ts";

const Id = z.object({ id: z.string().uuid() });

/** Linked accounts: list, link a card or bank (passkey-confirmed), remove. */
const routes: FastifyPluginAsyncZod = async (app) => {
  app.addHook("preHandler", requireUser);

  app.get("/funding-sources", { schema: { response: { 200: FundingSourcesResponse } } }, async (req) => ({
    sources: (await listFundingSources(userIdOf(req))).map(toFundingSourceDto),
  }));

  // The Send screen's live quote: what a send of this amount would debit, from the wallet or a linked account.
  app.get("/send/quote", { schema: { querystring: SendQuoteQuery, response: { 200: SendQuoteResponse } } }, async (req) => sendQuote(userIdOf(req), req.query));

  app.post("/funding-sources/card/start", { schema: { body: LinkCardRequest, response: { 201: StartLinkResponse } } }, async (req, reply) =>
    reply.status(201).send(await startCardLink(userIdOf(req), req.body)),
  );

  app.post("/funding-sources/bank/start", { schema: { body: LinkBankRequest, response: { 201: StartLinkResponse } } }, async (req, reply) =>
    reply.status(201).send(await startBankLink(userIdOf(req), req.body)),
  );

  // Passkey-gated (428 PASSKEY_REQUIRED round trip); a bank also sends the code from the 1 ₸ payment.
  app.post(
    "/funding-sources/:id/confirm",
    { schema: { params: Id, body: ConfirmLinkRequest, response: { 200: FundingSourceDto } } },
    async (req) => toFundingSourceDto(await confirmLink(userIdOf(req), req.params.id, req.body)),
  );

  app.delete("/funding-sources/:id", { schema: { params: Id } }, async (req, reply) => {
    await removeFundingSource(userIdOf(req), req.params.id);
    return reply.status(204).send();
  });
};

export default routes;
