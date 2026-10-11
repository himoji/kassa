import { CreditRecordExportRequest, CreditRecordExportResponse, CreditRecordVerifyResponse } from "@kassa/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";

import { env } from "../../env.ts";
import { HttpProblem } from "../../http/problem.ts";
import { requireUser, userIdOf } from "../auth/session.ts";
import { textPdf } from "./pdf.ts";
import { exportCreditRecord, findCreditRecord } from "./service.ts";

const Id = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/) });

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

  app.get("/public/verify/:id", { schema: { params: Id, response: { 200: CreditRecordVerifyResponse } } }, async (req) => {
    const r = await findCreditRecord(req.params.id);
    return {
      verifyId: r.bundle.verifyId,
      valid: r.valid,
      issuedAt: r.bundle.issuedAt,
      period: r.bundle.period,
      holder: r.bundle.holder,
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
    const b = r.bundle;
    const pdf = textPdf([
      "Kassa credit record (SIMULATED demo data)",
      "",
      `Holder: ${b.holder}`,
      `Period: ${b.period.from} to ${b.period.to}`,
      `Bills paid on time: ${b.summary.billsPaidOnTime} of ${b.summary.billsTotal}`,
      `Months covered: ${b.summary.monthsCovered}; months with regular income: ${b.summary.regularIncomeMonths}`,
      `Issued: ${b.issuedAt}`,
      "",
      `Verify id: ${b.verifyId}`,
      `SHA-256 (JCS, base64url): ${r.sha256}`,
      `Ed25519 key id: ${r.keyId}`,
      `Verify at: ${env().PUBLIC_ORIGIN.replace(/\/$/, "")}/verify/${b.verifyId}`,
    ]);
    return reply.type("application/pdf").header("content-disposition", `inline; filename="kassa-credit-record-${b.verifyId}.pdf"`).send(Buffer.from(pdf));
  });
};

export default routes;
