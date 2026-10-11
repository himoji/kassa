/*
 * Preset switches show their implicit changes: PATCH /settings returns `derivedChanges` (additive field) and creates one
 * SETTINGS_DERIVED_CHANGE notification with {key, params} plus English text. SMART → ASK_ME derives moneyMode
 * CAPPED_WALLET → PAY_IN_PLACE (Y6, p2 B6).
 */
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { getDb } from "../../src/db/client.ts";
import { notifications } from "../../src/db/schema.ts";
import { createUserWithPasskey, offlineEnvironment } from "../helpers/fixtures.ts";
import { bearer, useTestApp } from "../helpers/app.ts";
import { useTestDb } from "../helpers/db.ts";

const t = useTestDb();
const app = useTestApp();

describe("PATCH /settings reports preset-derived changes", () => {
  beforeEach(async () => {
    await t.reset();
    offlineEnvironment();
  });

  it("SMART → ASK_ME returns derivedChanges with moneyMode and creates one SETTINGS_DERIVED_CHANGE notification", async () => {
    const { userId } = await createUserWithPasskey({ preset: "SMART" });
    const res = await app().inject({ method: "PATCH", url: "/api/settings", headers: await bearer(userId), payload: { preset: "ASK_ME" } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { settings: { preset: string }; derivedChanges: Array<{ setting: string; from: string; to: string }> };
    expect(body.settings.preset).toBe("ASK_ME");
    expect(body.derivedChanges).toContainEqual({ setting: "moneyMode", from: "CAPPED_WALLET", to: "PAY_IN_PLACE" });

    const notes = (await getDb().select().from(notifications).where(eq(notifications.userId, userId))).filter((n) => n.kind === "SETTINGS_DERIVED_CHANGE");
    expect(notes).toHaveLength(1);
    expect(notes[0]!.data).toMatchObject({ key: "settings.derived_change", params: { changes: expect.arrayContaining([expect.objectContaining({ setting: "moneyMode" })]) } });
    expect(notes[0]!.body).toContain("moneyMode");
  });

  it("a patch without a preset switch has no derived changes and no notification", async () => {
    const { userId } = await createUserWithPasskey({ preset: "SMART" });
    const res = await app().inject({ method: "PATCH", url: "/api/settings", headers: await bearer(userId), payload: { notificationMode: "DIGEST" } });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { derivedChanges: unknown[] }).derivedChanges).toEqual([]);
    expect((await getDb().select().from(notifications).where(eq(notifications.userId, userId))).filter((n) => n.kind === "SETTINGS_DERIVED_CHANGE")).toHaveLength(0);
  });
});
