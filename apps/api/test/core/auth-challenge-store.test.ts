import { PairStartResponse, sha256Base64url } from "@kassa/shared";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { getDb } from "../../src/db/client.ts";
import { gatedChallenges, pairCodes, webauthnChallenges } from "../../src/db/schema.ts";
import { CHALLENGE_TTL_MS, putChallenge, putGated, takeChallenge, takeGated } from "../../src/modules/auth/challenges.ts";
import { clock } from "../../src/modules/clock/index.ts";
import { bearer, useTestApp } from "../helpers/app.ts";
import { useTestDb } from "../helpers/db.ts";
import { createUserWithPasskey } from "../helpers/fixtures.ts";
import { ensureIntelTables } from "../intel/intelTables.ts";

/*
 * The short-lived auth stores (auth/challenges.ts, auth/pair.ts) live in Postgres so create and consume may hit
 * different API instances: single use under concurrency, TTL on the Clock, user/purpose binding, codes hashed.
 */

const t = useTestDb();
const app = useTestApp();

beforeAll(async () => {
  await ensureIntelTables(t.db());
});

afterEach(() => {
  clock.setOffsetInMemoryForTests(0);
});

describe("WebAuthn challenges", () => {
  it("are stored in the database, taken once, and expire on the Clock", async () => {
    const id = await putChallenge("chal-1", { purpose: "recover", userId: "u1", codeId: "c1" });
    expect(await getDb().select().from(webauthnChallenges)).toHaveLength(1);
    const [a, b] = await Promise.all([takeChallenge(id), takeChallenge(id)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(a ?? b).toMatchObject({ purpose: "recover", userId: "u1", codeId: "c1", challenge: "chal-1" });

    await putChallenge("chal-2", { purpose: "login" });
    clock.setOffsetInMemoryForTests(CHALLENGE_TTL_MS + 1);
    expect(await takeChallenge("chal-2")).toBeNull();
    expect(await getDb().select().from(webauthnChallenges)).toHaveLength(0);
  });

  it("sweeps expired rows on insert", async () => {
    await putChallenge("old", { purpose: "login" });
    clock.setOffsetInMemoryForTests(CHALLENGE_TTL_MS + 1);
    await putChallenge("new", { purpose: "login" });
    expect((await getDb().select().from(webauthnChallenges)).map((r) => r.challenge)).toEqual(["new"]);
  });
});

describe("gated challenges", () => {
  it("bind user and purpose, keep the jsonb payload, and are consumed by any attempt", async () => {
    const { userId } = await createUserWithPasskey();
    const payload = { v: 1, kind: "TEST", nested: { b: 2, a: [1, "x"] } };
    const id = await putGated({ userId, purpose: "erase", hash: "h", payload });
    expect(await takeGated(id, userId, "settings")).toBeNull();
    expect(await takeGated(id, userId, "erase")).toBeNull();

    const id2 = await putGated({ userId, purpose: "erase", hash: "h", payload });
    const results = await Promise.all([takeGated(id2, userId, "erase"), takeGated(id2, userId, "erase"), takeGated(id2, userId, "erase")]);
    const won = results.filter(Boolean);
    expect(won).toHaveLength(1);
    expect(won[0]).toMatchObject({ userId, purpose: "erase", hash: "h", payload });
    expect(await getDb().select().from(gatedChallenges)).toHaveLength(0);
  });
});

describe("pairing codes", () => {
  it("are stored hashed and redeem once under concurrent attempts", async () => {
    const { userId, auth } = await createUserWithPasskey();
    const h = await bearer(userId);
    const first = await app().inject({ method: "POST", url: "/api/auth/pair/start", headers: h, payload: {} });
    expect(first.statusCode).toBe(428);
    const { challengeId, webauthnOptions } = first.json().details;
    const res = await app().inject({ method: "POST", url: "/api/auth/pair/start", headers: h, payload: { challengeId, assertion: await auth.assert(webauthnOptions.challenge) } });
    expect(res.statusCode, res.body).toBe(200);
    const { code } = PairStartResponse.parse(res.json());

    const rows = await getDb().select().from(pairCodes);
    expect(rows).toEqual([expect.objectContaining({ codeHash: sha256Base64url(code), userId })]);
    expect(JSON.stringify(rows)).not.toContain(code);

    const attempts = await Promise.all([0, 1, 2].map(() => app().inject({ method: "POST", url: "/api/auth/pair/complete", payload: { code } })));
    expect(attempts.map((r) => r.statusCode).sort()).toEqual([200, 401, 401]);
    expect(await getDb().select().from(pairCodes)).toHaveLength(0);
  });
});
