import { CreditRecordExportRequest, CreditRecordExportResponse, CreditRecordVerifyResponse } from "@kassa/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";

import { env } from "../../env.ts";
import { HttpProblem } from "../../http/problem.ts";
import { requireUser, userIdOf } from "../auth/session.ts";
import { textPdf } from "./pdf.ts";
import { publicJwks } from "./keys.ts";
import { type CreditBundle, exportCreditRecord, findCreditRecord, holderNameMatches } from "./service.ts";

/** The PDF's text: only the figures the bundle carries (the selected items), and the clamp when there was one. */
export function pdfLines(b: CreditBundle, sha256: string, keyId: string): string[] {
  const s = b.summary;
  const clamped = b.requestedPeriod && (b.requestedPeriod.from !== b.period.from || b.requestedPeriod.to !== b.period.to);
  return [
    "Kassa credit record (SIMULATED demo data)",
    "",
    `Holder: ${b.holder}`,
    `Period: ${b.period.from} to ${b.period.to}`,
    ...(clamped
      ? [`Requested: ${b.requestedPeriod!.from} to ${b.requestedPeriod!.to}; covered only from account opening (${b.accountOpenedOn}) to the issue day`]
      : []),
    `Included: ${b.items.join(", ")}`,
    `Months covered: ${s.monthsCovered}`,
    ...(s.billsTotal !== undefined ? [`Bills paid on time: ${s.billsPaidOnTime ?? 0} of ${s.billsTotal} due`] : []),
    ...(s.incomeMonths !== undefined ? [`Months with money received (recorded by Kassa): ${s.incomeMonths}`] : []),
    ...(s.budgetsTotal !== undefined ? [`Budgets within limit: ${s.budgetsWithinLimit ?? 0} of ${s.budgetsTotal} (a budget still running counts to the issue day)`] : []),
    ...(s.paymentsCompleted !== undefined
      ? [`Payments completed: ${s.paymentsCompleted}${s.paymentsOnTimePct !== undefined ? `; bill payments sent by the due date: ${s.paymentsOnTimePct}%` : ""}`]
      : []),
    ...(b.importedHistory ? [`Includes the account's simulated history before Kassa, imported when the demo account was set up (opened ${b.importedHistory.openedOn})`] : []),
    ...(b.holderName ? [`Holder name bound: ${b.holderName.source === "KYC" ? "identity-checked" : "as on the account"} (check a name at the verify link)`] : []),
    ...(s.regularIncomeMonths !== undefined ? [`Months with regular income (declared, version 1 record): ${s.regularIncomeMonths}`] : []),
    `Issued: ${b.issuedAt}`,
    "",
    `Verify id: ${b.verifyId}`,
    `SHA-256 (JCS, base64url): ${sha256}`,
    `Ed25519 key id: ${keyId}${b.v >= 3 ? " (signs utf8('kassa:credit-record:v3:' + SHA-256))" : " (signs utf8(SHA-256))"}`,
    `Public keys: ${env().PUBLIC_ORIGIN.replace(/\/$/, "")}/api/public/keys`,
    `Verify at: ${env().PUBLIC_ORIGIN.replace(/\/$/, "")}/verify/${b.verifyId}`,
  ];
}

const Id = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/) });
const NameQuery = z.object({ name: z.string().trim().min(1).max(200).optional() });

/**
 * POST /credit-record/export (auth); public: GET /public/verify/:id, GET /public/credit-record/:id.json|.pdf.
 * URLs are absolute on PUBLIC_ORIGIN (web app at /, API at /api — spec §3 hosting).
 */
const routes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    "/credit-record/export",
    { preHandler: requireUser, schema: { body: CreditRecordExportRequest, response: { 200: CreditRecordExportResponse } } },
    async (req) => {
      if (req.body.from > req.body.to) throw new HttpProblem(422, "BAD_PERIOD", "from must be on or before to");
      const { bundle, sha256 } = await exportCreditRecord(userIdOf(req), req.body);
      const origin = env().PUBLIC_ORIGIN.replace(/\/$/, "");
      return {
        verifyId: bundle.verifyId,
        verifyUrl: `${origin}/verify/${bundle.verifyId}`,
        jsonUrl: `${origin}/api/public/credit-record/${bundle.verifyId}.json`,
        pdfUrl: `${origin}/api/public/credit-record/${bundle.verifyId}.pdf`,
        sha256,
        createdAt: bundle.issuedAt,
      };
    },
  );

  // The keys that verify a record offline (scripts/credit-verify.ts), as a JWKS.
  app.get("/public/keys", async (_req, reply) => {
    reply.header("cache-control", "public, max-age=300");
    return publicJwks();
  });

  app.get("/public/verify/:id", { schema: { params: Id, querystring: NameQuery, response: { 200: CreditRecordVerifyResponse } } }, async (req) => {
    const r = await findCreditRecord(req.params.id);
    // ?name= : does the name the reader was told match the holder? Answered yes / no, the name is never shown.
    const nameMatch = req.query.name !== undefined ? holderNameMatches(r.bundle, req.query.name) : null;
    return {
      verifyId: r.bundle.verifyId,
      valid: r.valid,
      issuedAt: r.bundle.issuedAt,
      version: r.bundle.v,
      period: r.bundle.period,
      ...(r.bundle.requestedPeriod ? { requestedPeriod: r.bundle.requestedPeriod } : {}),
      ...(r.bundle.accountOpenedOn ? { accountOpenedOn: r.bundle.accountOpenedOn } : {}),
      holder: r.bundle.holder,
      ...(r.bundle.holderName ? { holderNameSource: r.bundle.holderName.source } : {}),
      ...(nameMatch !== null ? { nameMatch } : {}),
      ...(r.bundle.importedHistory ? { importedHistory: r.bundle.importedHistory } : {}),
      items: r.bundle.items,
      summary: r.bundle.summary,
      sha256: r.sha256,
      keyId: r.keyId,
      simulated: r.bundle.simulated,
    };
  });

  app.get("/public/credit-record/:file", { schema: { params: z.object({ file: z.string().regex(/^[A-Za-z0-9_-]{16,64}\.(json|pdf)$/) }) } }, async (req, reply) => {
    const [id, ext] = req.params.file.split(".") as [string, string];
    const r = await findCreditRecord(id);
    if (ext === "json") {
      return reply.type("application/json").send({ bundle: r.bundle, sha256: r.sha256, sig: r.sig, keyId: r.keyId, alg: "Ed25519" });
    }
    const pdf = textPdf(pdfLines(r.bundle, r.sha256, r.keyId));
    return reply.type("application/pdf").header("content-disposition", `inline; filename="kassa-credit-record-${r.bundle.verifyId}.pdf"`).send(Buffer.from(pdf));
  });
};

export default routes;
