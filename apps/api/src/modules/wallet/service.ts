/*
 * The agent's wallet from the user's side: test money in, and Kassa IDs so users can pay each other.
 *
 * Top-up (POST /wallet/top-ups): the app shows a wallet sheet (Apple Pay, Google Pay, Samsung Pay or a card); the tap
 * charges a Stripe test-mode PaymentIntent with Stripe's test card when Stripe test keys are set, else nothing at all.
 * Either way no real money moves. The amount is then credited to the user's capped wallet in the sandbox bank, so the
 * agent can spend it under the same signed rules as any other balance. Money only comes IN here, to the user's own
 * wallet, so no passkey is asked (the wallet tap itself is the confirmation); a day's top-ups are capped by the
 * user's signed per-day cap, and each is ledgered.
 *
 * Kassa ID ("KSA-7QMX-2HVA"): a public handle derived from the user id. Another user adds it as a payee (scheme
 * KASSA_USER); paying it is an ordinary signed order on the bank rail, delivered into this user's wallet.
 */
import { createHash, randomUUID } from "node:crypto";

import { fromMinor, KASSA_ID_ALPHABET, SupportedCurrency, type TopUpRequest, type TopUpResponse, type WalletResponse } from "@kassa/shared";
import { and, eq, gte, sql } from "drizzle-orm";

import { getDb } from "../../db/client.ts";
import { ledgerEntries, profiles, users } from "../../db/schema.ts";
import { env } from "../../env.ts";
import { HttpProblem } from "../../http/problem.ts";
import { clock } from "../clock/index.ts";
import { chargeSource, PullDeclined } from "../funding-sources/pull.ts";
import { activeFundingSource } from "../funding-sources/store.ts";
import { ledger } from "../ledger/index.ts";
import { toHome } from "../money/fx.ts";
import { notify } from "../notifications/service.ts";
import { bankCall, bankMode } from "../rails/bankApi.ts";
import { mockWorld } from "../rails/http.ts";
import { stripe } from "../rails/issuing.ts";
import { effectiveOf } from "../users/service.ts";

// ---------- Kassa IDs ----------

/** 8 characters from a hash of the user id, in an alphabet without look-alikes: "KSA-XXXX-XXXX". */
export function kassaIdFor(userId: string): string {
  const h = createHash("sha256").update(`kassa-id:v1:${userId}`).digest();
  let out = "";
  for (let i = 0; i < 8; i++) out += KASSA_ID_ALPHABET[h[i]! % KASSA_ID_ALPHABET.length];
  return `KSA-${out.slice(0, 4)}-${out.slice(4)}`;
}

/** The user a Kassa ID belongs to, or null. A scan of user ids: fine at demo scale (a lookup column would replace it). */
export async function userByKassaId(kassaId: string): Promise<{ id: string; displayName: string } | null> {
  const rows = await getDb().select({ id: users.id, displayName: users.displayName }).from(users);
  return rows.find((u) => kassaIdFor(u.id) === kassaId) ?? null;
}

// ---------- Wallet profile in the sandbox bank ----------

/** A stable sandbox-bank profile id for a user who has none yet (seeded personas keep theirs). */
function derivedProfileId(userId: string): number {
  const h = createHash("sha256").update(`kassa-wallet:v1:${userId}`).digest();
  return 30_000_000 + (h.readUInt32BE(0) % 9_000_000);
}

/**
 * The user's wallet profile, opened in the mock bank when missing. Idempotent (the mock bank is in memory and may have
 * restarted). With the Wise sandbox there is one shared sandbox profile and nothing to open.
 */
export async function ensureWalletProfile(userId: string): Promise<number> {
  const db = getDb();
  const p = (await db.select({ id: profiles.bankProfileId }).from(profiles).where(eq(profiles.userId, userId)))[0];
  let id = p?.id ?? null;
  if (id === null) {
    id = derivedProfileId(userId);
    await db.update(profiles).set({ bankProfileId: id }).where(eq(profiles.userId, userId));
  }
  if (bankMode() === "mock") await mockWorld("POST", "/bank/wallets", { profileId: id, aliases: [userId] });
  return id;
}

// ---------- Top-ups ----------

const PROVIDER = () => (env().stripeEnabled ? ("stripe-test" as const) : ("simulated" as const));

function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

async function topUpsToday(userId: string): Promise<{ homeMinor: number; byKey: Map<string, TopUpResponse> }> {
  const rows = await getDb()
    .select({ payload: ledgerEntries.payload })
    .from(ledgerEntries)
    .where(and(eq(ledgerEntries.type, "WALLET_TOPUP"), sql`${ledgerEntries.payload}->>'userId' = ${userId}`, gte(ledgerEntries.ts, utcDayStart(clock.now()))));
  let homeMinor = 0;
  const byKey = new Map<string, TopUpResponse>();
  for (const r of rows) {
    const p = r.payload as { homeAmountMinor?: number; idempotencyKey?: string; response?: TopUpResponse };
    homeMinor += p.homeAmountMinor ?? 0;
    if (p.idempotencyKey && p.response) byKey.set(p.idempotencyKey, p.response);
  }
  return { homeMinor, byKey };
}

async function walletContext(userId: string) {
  const db = getDb();
  const u = (await db.select().from(users).where(eq(users.id, userId)))[0];
  if (!u) throw new HttpProblem(404, "NOT_FOUND", "user not found");
  const prof = (await db.select({ caps: profiles.caps }).from(profiles).where(eq(profiles.userId, userId)))[0];
  return { user: u, canTopUp: effectiveOf(u).moneyMode === "CAPPED_WALLET", dailyLimit: prof?.caps?.perDayMinor ?? 0 };
}

export async function walletInfo(userId: string): Promise<WalletResponse> {
  const { user, canTopUp, dailyLimit } = await walletContext(userId);
  return {
    kassaId: kassaIdFor(userId),
    canTopUp,
    topUpProvider: PROVIDER(),
    topUpDailyLimitHomeMinor: dailyLimit,
    topUpTodayHomeMinor: (await topUpsToday(userId)).homeMinor,
    homeCurrency: user.homeCurrency,
    currencies: [...SupportedCurrency.options],
  };
}

/** Stripe test charge: Stripe's own test card stands in for the wallet token (Apple Pay in test mode does the same). */
async function chargeTest(userId: string, req: TopUpRequest): Promise<string> {
  if (!env().stripeEnabled) return `sim_tap_${randomUUID()}`;
  const pi = await stripe().paymentIntents.create(
    {
      amount: req.amountMinor,
      currency: req.currency.toLowerCase(),
      payment_method: "pm_card_visa",
      automatic_payment_methods: { enabled: true, allow_redirects: "never" },
      confirm: true,
      description: `Kassa wallet top-up (${req.method}, test mode)`,
      metadata: { kassaUserId: userId, kassaTopUp: req.idempotencyKey, method: req.method },
    },
    { idempotencyKey: `kassa-topup-${req.idempotencyKey}` },
  );
  if (pi.status !== "succeeded") throw new HttpProblem(402, "TOPUP_DECLINED", `The test charge did not succeed (${pi.status})`);
  return pi.id;
}

/** (linked accounts) Add money from a linked card or bank: the same pull a send from it makes. */
async function chargeLinked(userId: string, req: TopUpRequest): Promise<{ ref: string; simulated: boolean }> {
  const source = req.fundingSourceId ? await activeFundingSource(userId, req.fundingSourceId) : null;
  if (!source) throw new HttpProblem(422, "FUNDING_SOURCE_UNAVAILABLE", "Pick a linked card or bank account to add money from", { reasonCodes: ["FUNDING_SOURCE_UNAVAILABLE"] });
  if (source.currency !== req.currency) throw new HttpProblem(422, "CURRENCY_MISMATCH", `This account pays in ${source.currency}`, { reasonCodes: ["CURRENCY_MISMATCH"] });
  try {
    return await chargeSource(source, req.amountMinor, req.currency, `topup-${req.idempotencyKey}`);
  } catch (err) {
    if (err instanceof PullDeclined) throw new HttpProblem(402, "TOPUP_DECLINED", err.message, { reasonCodes: ["FUNDING_PULL_DECLINED"] });
    throw err;
  }
}

/** Credits the sandbox bank: the mock bank's top-up, or the Wise sandbox's balance top-up simulation. */
export async function creditWallet(userId: string, currency: string, amountMinor: number, reference: string): Promise<number | null> {
  const profile = await ensureWalletProfile(userId);
  if (bankMode() === "mock") {
    const r = await mockWorld<{ balanceAfterMinor: number }>("POST", "/bank/top-ups", { profileId: profile, currency, amountMinor, reference });
    return r.balanceAfterMinor;
  }
  const balances = await bankCall<{ id: number; currency: string }[]>("GET", `/v4/profiles/${profile}/balances?types=STANDARD`);
  const balance = balances.find((b) => b.currency === currency);
  if (!balance) throw new HttpProblem(422, "TOPUP_NO_BALANCE", `The Wise sandbox profile has no ${currency} balance; open one in the sandbox first`);
  await bankCall("POST", "/v1/simulation/balance/topup", { profileId: profile, balanceId: balance.id, currency, amount: Number(fromMinor(amountMinor, currency)) });
  return null;
}

export async function topUp(userId: string, req: TopUpRequest): Promise<TopUpResponse> {
  const { user, canTopUp, dailyLimit } = await walletContext(userId);
  if (!canTopUp) {
    throw new HttpProblem(409, "TOPUP_NEEDS_WALLET", "Top-ups go to the capped wallet; switch money mode to Capped wallet first");
  }
  const today = await topUpsToday(userId);
  const seen = today.byKey.get(req.idempotencyKey);
  if (seen) return seen;
  const home = await toHome(req.amountMinor, req.currency, user.homeCurrency, clock.now(), "nearest");
  if (today.homeMinor + home.amountMinor > dailyLimit) {
    throw new HttpProblem(422, "TOPUP_DAILY_LIMIT", "That would go over today's top-up limit (your signed per-day cap)", {
      details: { limitHomeMinor: dailyLimit, todayHomeMinor: today.homeMinor, homeCurrency: user.homeCurrency },
    });
  }
  const linked = req.method === "LINKED" ? await chargeLinked(userId, req) : null;
  const providerRef = linked ? linked.ref : await chargeTest(userId, req);
  const balanceAfterMinor = await creditWallet(userId, req.currency, req.amountMinor, `topup:${req.idempotencyKey}`);
  const response: TopUpResponse = {
    topUpId: req.idempotencyKey,
    amountMinor: req.amountMinor,
    currency: req.currency,
    method: req.method,
    provider: linked ? (linked.simulated ? "simulated" : "stripe-test") : PROVIDER(),
    providerRef,
    balanceAfterMinor,
    simulated: true,
  };
  await ledger.append("WALLET_TOPUP", {
    userId,
    idempotencyKey: req.idempotencyKey,
    amountMinor: req.amountMinor,
    currency: req.currency,
    homeAmountMinor: home.amountMinor,
    method: req.method,
    provider: response.provider,
    providerRef,
    bank: bankMode(),
    response,
  });
  await notify(userId, {
    kind: "WALLET_TOPUP",
    title: "Test money added",
    body: `Added to your Kassa wallet from ${req.method === "LINKED" ? "your linked account" : req.method === "CARD" ? "a test card" : "a wallet tap"} (test mode, no real money).`,
    data: { amountMinor: req.amountMinor, currency: req.currency, method: req.method },
  }).catch(() => undefined);
  return response;
}

/** The sender's name for a wallet.received event (its sandbox-bank profile → user). */
export async function senderNameForProfile(profileId: number): Promise<string | null> {
  const row = (
    await getDb()
      .select({ name: users.displayName })
      .from(profiles)
      .innerJoin(users, eq(users.id, profiles.userId))
      .where(eq(profiles.bankProfileId, profileId))
  )[0];
  return row?.name ?? null;
}
