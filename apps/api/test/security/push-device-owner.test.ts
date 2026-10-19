/*
 * POST /devices (Expo push token): a token registered to one user is never moved to another (409 DEVICE_TOKEN_TAKEN,
 * row unchanged), so a replayed push token cannot redirect someone's notifications. Re-registering one's own token
 * stays idempotent and un-revokes it.
 */
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { getDb } from "../../src/db/client.ts";
import { devices } from "../../src/db/schema.ts";
import { bearer, useTestApp } from "../helpers/app.ts";
import { useTestDb } from "../helpers/db.ts";
import { createUserWithPasskey } from "../helpers/fixtures.ts";

useTestDb();
const app = useTestApp();

const register = async (userId: string, expoPushToken: string, platform = "ios") =>
  app().inject({ method: "POST", url: "/api/devices", headers: await bearer(userId), payload: { kind: "APP", expoPushToken, platform } });

const rowsFor = (expoPushToken: string) => getDb().select().from(devices).where(eq(devices.pushToken, expoPushToken));

describe("POST /devices ownership", () => {
  it("refuses a push token registered to another user with 409 and leaves the row unchanged", async () => {
    const a = await createUserWithPasskey();
    const b = await createUserWithPasskey();
    const token = "ExponentPushToken[victim-install-1]";
    expect((await register(a.userId, token)).statusCode).toBe(204);
    const [before] = await rowsFor(token);
    // Revoked rows stay theirs too: no takeover of a revoked token either.
    await getDb().update(devices).set({ revokedAt: new Date("2026-10-01T00:00:00Z") }).where(eq(devices.id, before!.id));
    const [revoked] = await rowsFor(token);

    const res = await register(b.userId, token, "android");
    expect(res.statusCode, res.body).toBe(409);
    expect(res.headers["content-type"]).toContain("application/problem+json");
    expect(res.json()).toMatchObject({ status: 409, code: "DEVICE_TOKEN_TAKEN" });

    const after = await rowsFor(token);
    expect(after).toHaveLength(1);
    expect(after[0]).toEqual(revoked);
    expect(after[0]!.userId).toBe(a.userId);
  });

  it("lets the same user re-register their token (idempotent, un-revokes it)", async () => {
    const a = await createUserWithPasskey();
    const token = "ExponentPushToken[own-install-1]";
    expect((await register(a.userId, token)).statusCode).toBe(204);
    const [first] = await rowsFor(token);
    await getDb().update(devices).set({ revokedAt: new Date("2026-10-01T00:00:00Z") }).where(eq(devices.id, first!.id));

    expect((await register(a.userId, token)).statusCode).toBe(204);
    const rows = await rowsFor(token);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: first!.id, userId: a.userId, kind: "APP", revokedAt: null });
  });
});
