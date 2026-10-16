/*
 * Users and profiles: creation, settings view, caps. Settings changes go through rule_changes (I8);
 * see users/settings.ts.
 */
import { effectiveSettings, type UserSettings } from "@kassa/shared";
import { eq } from "drizzle-orm";

import type { DbOrTx } from "../../db/client.ts";
import { profiles, users, type CapsJson } from "../../db/schema.ts";
import { PROFILE_CORE } from "../../db/profile-columns.ts";
import { notFound } from "../../http/problem.ts";

/**
 * Default caps in home-currency minor units (spec §10 step 5/9). Example values sized for the KZT demo:
 * per payment ₸1,500,000; day ₸2,000,000; month ₸3,000,000; small auto limit ₸10,000 (spec §10 step 9);
 * protected reserve ₸50,000.
 */
export const DEFAULT_CAPS: CapsJson = {
  perPaymentMinor: 150_000_000,
  perDayMinor: 200_000_000,
  perMonthMinor: 300_000_000,
  smallAutoMinor: 1_000_000,
  reserveMinor: 5_000_000,
};

export async function createUser(
  tx: DbOrTx,
  u: { id: string; displayName: string; homeCurrency?: string },
): Promise<void> {
  await tx.insert(users).values({ id: u.id, displayName: u.displayName, homeCurrency: u.homeCurrency ?? "KZT" });
  await tx.insert(profiles).values({ userId: u.id, caps: DEFAULT_CAPS }).onConflictDoNothing();
}

export async function loadUser(db: DbOrTx, userId: string) {
  const rows = await db.select().from(users).where(eq(users.id, userId));
  const u = rows[0];
  if (!u) throw notFound("user");
  const p = (await db.select(PROFILE_CORE).from(profiles).where(eq(profiles.userId, userId)))[0];
  const profile = p ?? {
    userId,
    incomes: [],
    notificationMode: "EACH" as const,
    reserveRules: {},
    caps: DEFAULT_CAPS,
    baseRules: null,
    baseRulesHash: null,
    baseRulesAssertion: null,
    baseRulesSignedAt: null,
    bankProfileId: null,
    stripeCardholderId: null,
  };
  return { user: u, profile, caps: profile.caps ?? DEFAULT_CAPS };
}

export function settingsOf(u: typeof users.$inferSelect, notificationMode: UserSettings["notificationMode"]): UserSettings {
  return {
    preset: u.preset,
    region: u.region,
    homeCurrency: u.homeCurrency,
    notificationMode,
    overrides: u.overrides,
  };
}

export function effectiveOf(u: typeof users.$inferSelect) {
  return effectiveSettings(u.preset, u.overrides);
}
