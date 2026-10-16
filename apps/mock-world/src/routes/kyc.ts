import type { FastifyInstance } from "fastify";

import { HttpError, parseWith } from "../errors.ts";
import { KycCheckBody, type KycDesk } from "../kyc/kyc.ts";

/*
 * (added 2026-10-16) Identity check (KYC), simulated (kyc/kyc.ts):
 *   POST /kyc/checks       {accountName, document{type, number, country, fullName, dateOfBirth, expiresOn}, liveness{result}}
 *                          -> {checkId, outcome VERIFIED | REVIEW | REJECTED, reasonCodes, document{type, country, last4}, ...}
 *   GET  /kyc/checks/:id   the outcome only
 * Deterministic, no network. The answer never echoes the full document number, the name or the date of birth.
 */
export function kycRoutes(app: FastifyInstance, deps: { desk: KycDesk }): void {
  app.post("/kyc/checks", async (req) => deps.desk.check(parseWith(KycCheckBody, req.body)));

  app.get("/kyc/checks/:id", async (req) => {
    const id = (req.params as { id?: unknown }).id;
    const r = typeof id === "string" ? deps.desk.get(id) : null;
    if (!r) throw new HttpError(404, "NOT_FOUND", "No such identity check");
    return { ...r, simulated: true };
  });
}
