/* HTTP: order sheet data + approve/reject (spec §7 T2), and onboarding confirm (passkey-signed base rules). */
import { beforeEach, describe, expect, it } from "vitest";

import { proposeOrder } from "../../src/modules/rules/index.ts";
import { bearer, useTestApp } from "../helpers/app.ts";
import { addPayee, createUserWithPasskey, IBAN_UNIVERSITY, offlineEnvironment } from "../helpers/fixtures.ts";
import { useTestDb } from "../helpers/db.ts";

const t = useTestDb();
const app = useTestApp();

describe("orders over HTTP", () => {
  beforeEach(async () => {
    await t.reset();
    offlineEnvironment();
  });

  async function pending() {
    const { userId, auth } = await createUserWithPasskey();
    const payee = await addPayee(userId, { name: "Riverside University Budapest", kind: "UNIVERSITY", currency: "EUR", account: IBAN_UNIVERSITY });
    const r = await proposeOrder({ userId, createdBy: "AGENT", payeeId: payee.id, amountMinor: 240_000, currency: "EUR", purpose: "Tuition" });
    return { userId, auth, proposalId: r.proposalId, h: await bearer(userId) };
  }

  it("GET returns the canonical order and challenge = orderHash; approve pays", async () => {
    const { auth, proposalId, h } = await pending();
    const view = await app().inject({ method: "GET", url: `/api/orders/${proposalId}`, headers: h });
    expect(view.statusCode).toBe(200);
    const v = view.json();
    expect(v.webauthnOptions.challenge).toBe(v.orderHash);
    expect(v.canonicalOrder).toMatchObject({ v: 1, amountMinor: 240_000, currency: "EUR", payeeName: "Riverside University Budapest" });
    expect(v.canonicalOrder.nonce).toMatch(/^[A-Za-z0-9_-]{22}$/); // 16 bytes base64url
    const ok = await app().inject({ method: "POST", url: `/api/orders/${proposalId}/approve`, headers: h, payload: { assertion: auth.assert(v.orderHash) } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ tier: "T2", paymentStatus: "PROCESSING" });
    const list = await app().inject({ method: "GET", url: "/api/proposals?status=EXECUTED", headers: h });
    expect(list.json().proposals).toHaveLength(1);
  });

  it("A8-style: an assertion over a different order (lying confirmation) is rejected", async () => {
    const { auth, proposalId, h } = await pending();
    const res = await app().inject({ method: "POST", url: `/api/orders/${proposalId}/approve`, headers: h, payload: { assertion: auth.assert("aGFzaC1vZi1hLWRpZmZlcmVudC1vcmRlcg") } });
    expect(res.statusCode).toBe(403);
    expect(res.json().reasonCodes).toEqual(["ORDER_HASH_MISMATCH"]);
  });

  it("expired order → 410 ORDER_EXPIRED; reopening re-issues a fresh order", async () => {
    const { auth, proposalId, h } = await pending();
    const first = (await app().inject({ method: "GET", url: `/api/orders/${proposalId}`, headers: h })).json();
    const { clock } = await import("../../src/modules/clock/index.ts");
    clock.setOffsetInMemoryForTests(11 * 60_000);
    const h2 = await bearer((first.canonicalOrder as { userId: string }).userId);
    const late = await app().inject({ method: "POST", url: `/api/orders/${proposalId}/approve`, headers: h2, payload: { assertion: auth.assert(first.orderHash) } });
    expect(late.statusCode).toBe(410);
    const fresh = (await app().inject({ method: "GET", url: `/api/orders/${proposalId}`, headers: h2 })).json();
    expect(fresh.orderHash).not.toBe(first.orderHash);
    const ok = await app().inject({ method: "POST", url: `/api/orders/${proposalId}/approve`, headers: h2, payload: { assertion: auth.assert(fresh.orderHash) } });
    expect(ok.statusCode).toBe(200);
    clock.setOffsetInMemoryForTests(0);
  });

  it("reject → 204 and no longer approvable; other users get 404", async () => {
    const { auth, proposalId, h } = await pending();
    const other = await createUserWithPasskey();
    expect((await app().inject({ method: "GET", url: `/api/orders/${proposalId}`, headers: await bearer(other.userId) })).statusCode).toBe(404);
    expect((await app().inject({ method: "POST", url: `/api/orders/${proposalId}/reject`, headers: h, payload: {} })).statusCode).toBe(204);
    const v = await app().inject({ method: "POST", url: `/api/orders/${proposalId}/approve`, headers: h, payload: { assertion: auth.assert("x") } });
    expect(v.statusCode).toBe(409);
  });
});

describe("onboarding confirm", () => {
  beforeEach(async () => {
    await t.reset();
    offlineEnvironment();
  });

  it("signs base rules with the passkey once; /me then reports onboarded", async () => {
    const { userId, auth } = await createUserWithPasskey({ preset: "ASK_ME" });
    const h = await bearer(userId);
    const conversationId = crypto.randomUUID();
    const opt = await app().inject({ method: "POST", url: "/api/onboarding/confirm/options", headers: h, payload: { conversationId } });
    expect(opt.statusCode).toBe(200);
    const o = opt.json();
    expect(o.webauthnOptions.challenge).toBe(o.rulesHash);
    const bad = await app().inject({ method: "POST", url: "/api/onboarding/confirm", headers: h, payload: { conversationId, challengeId: o.challengeId, core: o.core, assertion: auth.assert("nope") } });
    expect(bad.statusCode).toBe(403);
    const opt2 = (await app().inject({ method: "POST", url: "/api/onboarding/confirm/options", headers: h, payload: { conversationId } })).json();
    const ok = await app().inject({ method: "POST", url: "/api/onboarding/confirm", headers: h, payload: { conversationId, challengeId: opt2.challengeId, core: opt2.core, assertion: auth.assert(opt2.rulesHash) } });
    expect(ok.statusCode).toBe(200);
    expect((await app().inject({ method: "GET", url: "/api/me", headers: h })).json().onboarded).toBe(true);
    const again = await app().inject({ method: "POST", url: "/api/onboarding/confirm/options", headers: h, payload: { conversationId } });
    const twice = await app().inject({ method: "POST", url: "/api/onboarding/confirm", headers: h, payload: { conversationId, challengeId: again.json().challengeId, core: again.json().core, assertion: auth.assert(again.json().rulesHash) } });
    expect(twice.statusCode).toBe(409);
  });
});
