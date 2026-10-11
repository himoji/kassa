/*
 * Y3 (cn reviewer note 2): for a user in region CN, AI processing (agent chat, documents, onboarding chat, the sim
 * planner) with a model outside Kassa's server is a cross-border transfer of personal information that needs a
 * SEPARATE consent (PIPL Art. 38–39), on top of the general AI consent. Without it: 403 PIPL_CONSENT_REQUIRED.
 */
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { getDb } from "../../src/db/client.ts";
import { users } from "../../src/db/schema.ts";
import { aiNotice, assertAiProcessingAllowed } from "../../src/modules/privacy/notice.ts";
import { exportUserData } from "../../src/modules/privacy/service.ts";
import { bearer, useTestApp } from "../helpers/app.ts";
import { useTestDb } from "../helpers/db.ts";
import { createUserWithPasskey } from "../helpers/fixtures.ts";
import { ensureIntelTables } from "../intel/intelTables.ts";

const t = useTestDb();
const app = useTestApp();

beforeAll(async () => {
  await ensureIntelTables(t.db());
});

const onboarding = async (h: Record<string, string>) => app().inject({ method: "POST", url: "/api/onboarding/message", headers: h, payload: { conversationId: "00000000-0000-4000-8000-0000000000ab", text: "hello" } });
const chat = async (h: Record<string, string>) =>
  app().inject({ method: "POST", url: "/api/agent/message", headers: h, payload: { conversationId: "00000000-0000-4000-8000-0000000000aa", text: "what is due?" } });

describe("PIPL separate consent for region CN (Y3)", () => {
  it("region CN without PIPL consent → 403 PIPL_CONSENT_REQUIRED on agent and onboarding routes", async () => {
    const { userId } = await createUserWithPasskey({ region: "CN" });
    const h = await bearer(userId);
    for (const r of [await chat(h), await onboarding(h)]) {
      expect(r.statusCode, r.body).toBe(403);
      const body = r.json() as { code: string; reasonCodes: string[]; details: { aiNotice: { crossBorderConsentRequired?: boolean; text: string } } };
      expect(body.code).toBe("PIPL_CONSENT_REQUIRED");
      expect(body.reasonCodes).toEqual(["PIPL_CONSENT_REQUIRED"]);
      expect(body.details.aiNotice.crossBorderConsentRequired).toBe(true);
      expect(body.details.aiNotice.text).toMatch(/PIPL/);
    }
    await expect(assertAiProcessingAllowed(userId)).rejects.toMatchObject({ code: "PIPL_CONSENT_REQUIRED" });
  });

  it("the general AI consent is still checked first", async () => {
    const { userId } = await createUserWithPasskey({ region: "CN", aiConsent: false });
    const r = await chat(await bearer(userId));
    expect(r.statusCode).toBe(403);
    expect((r.json() as { code: string }).code).toBe("AI_CONSENT_REQUIRED");
  });

  it("POST /privacy/pipl-consent gives and withdraws the separate consent", async () => {
    const { userId } = await createUserWithPasskey({ region: "CN" });
    const h = await bearer(userId);
    const give = await app().inject({ method: "POST", url: "/api/privacy/pipl-consent", headers: h, payload: { consent: true } });
    expect(give.statusCode, give.body).toBe(200);
    const at = (give.json() as { piplConsentAt: string | null }).piplConsentAt;
    expect(at).toMatch(/^\d{4}-/);
    await expect(assertAiProcessingAllowed(userId)).resolves.toBeUndefined();
    const r = await chat(h);
    expect(r.statusCode).not.toBe(403);
    // Idempotent.
    const again = await app().inject({ method: "POST", url: "/api/privacy/pipl-consent", headers: h, payload: { consent: true } });
    expect((again.json() as { piplConsentAt: string }).piplConsentAt).toBe(at);
    // The export shows it.
    const exp = await exportUserData(userId);
    expect((exp.data.user as { piplConsentAt: string | null }).piplConsentAt).toBe(at);
    // Withdrawal (as easy as giving it) → refused again.
    const w = await app().inject({ method: "POST", url: "/api/privacy/pipl-consent", headers: h, payload: { consent: false } });
    expect((w.json() as { piplConsentAt: string | null }).piplConsentAt).toBeNull();
    await expect(assertAiProcessingAllowed(userId)).rejects.toMatchObject({ code: "PIPL_CONSENT_REQUIRED" });
  });

  it("region EU needs no PIPL consent", async () => {
    const { userId } = await createUserWithPasskey({ region: "EU" });
    await expect(assertAiProcessingAllowed(userId)).resolves.toBeUndefined();
    expect(aiNotice("EU").crossBorderConsentRequired ?? false).toBe(false);
  });

  it("the CN notice names the separate consent and how to give it", () => {
    const n = aiNotice("CN");
    expect(n.crossBorderConsentRequired).toBe(true);
    expect(n.text).toMatch(/PIPL Art\. 38–39/);
    expect(n.text).toMatch(/separate consent/);
    expect(n.text).not.toMatch(/does not yet ask/);
  });

  it("erasure clears the PIPL consent", async () => {
    const { userId } = await createUserWithPasskey({ region: "CN" });
    await getDb().update(users).set({ piplConsentAt: new Date() }).where(eq(users.id, userId));
    const { eraseUser } = await import("../../src/modules/privacy/service.ts");
    await eraseUser(userId);
    const row = (await getDb().select({ at: users.piplConsentAt }).from(users).where(eq(users.id, userId)))[0]!;
    expect(row.at).toBeNull();
  });
});
