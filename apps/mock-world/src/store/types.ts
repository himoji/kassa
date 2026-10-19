import type { Leases } from "./leases.ts";

/*
 * (added 2026-10-18) Where the mock world keeps its state.
 *
 * Locally (and in tests) everything lives in memory, as before. On a deployed build the mock world runs inside every
 * serverless instance (api/index.ts), so in-memory state differed per instance and vanished on a cold start: balances
 * came back empty, a top-up answered from a fresh wallet, a paid school invoice was open again elsewhere. There the
 * state lives in Postgres (store/postgres.ts, tables from the API's migration 0023_mock_world_state):
 *
 *   balances, wallets, aliases, test top-ups  rows changed by single atomic statements (`amount = amount + $n`, a
 *                                             debit only `where amount >= $n`), so two instances moving money in
 *                                             the same wallet never lose an update or overdraw it;
 *   everything else (quotes, recipients,      one JSON row per entity, synchronised around each request and tick
 *   transfers, QR codes, shop orders, school  (store/sync.ts): changes from other instances are read before the
 *   invoices, supplier POs, KYC outcomes)     handler runs, and the entities this instance changed are written
 *                                             before the response leaves. Last writer wins per entity.
 */

export type Row = Record<string, unknown>;

/** The few SQL calls the Postgres store makes. Adapters exist for postgres.js (api/index.ts) and PGlite (tests). */
export interface SqlClient {
  query(text: string, params?: unknown[]): Promise<Row[]>;
  transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T>;
}

export interface SeedWallet {
  profileId: number;
  /** Other ids accepted for the same profile (the Kassa user UUID, the persona key). */
  aliases?: string[];
  balances: { currency: string; amountMinor: number }[];
}

export type TopUpResult =
  | { kind: "ok"; balanceAfterMinor: number; created: boolean }
  | { kind: "conflict" }
  | { kind: "no_wallet" };

/**
 * (added 2026-10-19) A one-time card charge paid from a wallet balance. `reference` is the authorization's idempotency
 * key ("card-auth:<authorization id>"); `requestCurrency`/`requestAmountMinor` are the charge as the merchant sent it,
 * `currency`/`amountMinor` what left the wallet (the funding balance, converted when it differs).
 */
export interface CardDebitRecord {
  reference: string;
  cardId: string;
  profile: number;
  requestCurrency: string;
  requestAmountMinor: number;
  currency: string;
  amountMinor: number;
  balanceAfterMinor: number;
}

export type CardDebitResult =
  | { kind: "ok"; debit: CardDebitRecord; created: boolean }
  /** The reference or the card already paid a different charge. */
  | { kind: "conflict" }
  /** The balance does not cover it (or there is no wallet); nothing moved and nothing was recorded. */
  | { kind: "insufficient" };

/** The same charge as a recorded one (a replay, or a retry on the same single-use card). */
export function sameCardCharge(seen: CardDebitRecord, d: Omit<CardDebitRecord, "balanceAfterMinor">): boolean {
  return seen.cardId === d.cardId && seen.profile === d.profile && seen.requestCurrency === d.requestCurrency && seen.requestAmountMinor === d.requestAmountMinor;
}

/** Money in the mock bank. Every method is atomic on its own. */
export interface BalanceStore {
  /** Canonical profile id for an alias (lower-cased) or a numeric id as text. */
  resolve(alias: string): Promise<number | undefined>;
  hasWallet(profile: number): Promise<boolean>;
  /** Idempotent. Registers the aliases either way. */
  openWallet(profile: number, aliases: string[]): Promise<boolean>;
  /** Currency → minor units, in the order the currencies were first credited; null without a wallet. */
  balances(profile: number): Promise<[string, number][] | null>;
  /** Adds money; null without a wallet. Returns the new balance. */
  credit(profile: number, currency: string, amountMinor: number): Promise<number | null>;
  /** Takes money only if that much is there; null otherwise. Returns the new balance. */
  debit(profile: number, currency: string, amountMinor: number): Promise<number | null>;
  /** Test money in, idempotent by reference (a retried tap adds the money once). */
  topUp(reference: string, profile: number, currency: string, amountMinor: number): Promise<TopUpResult>;
  /** (2026-10-19) The card debit recorded under this reference, else the one recorded for this card; null if none. */
  findCardDebit(reference: string, cardId: string): Promise<CardDebitRecord | null>;
  /**
   * (2026-10-19) Card charge from one balance, idempotent: the debit and its record commit together. A reference or
   * card already recorded returns that record (created false) when it is the same charge, else conflict. A card is
   * debited at most once.
   */
  cardDebit(d: Omit<CardDebitRecord, "balanceAfterMinor">): Promise<CardDebitResult>;
  /** Next id for recipients, transfers and balance transactions (unique across instances). */
  nextId(): Promise<number>;
  /** Back to the seeded wallets only. */
  reset(): Promise<void>;
  /** Re-creates seeded wallets that are missing (after the world was reset or wiped elsewhere); never touches others. */
  seed(): Promise<void>;
}

export interface EntityRow {
  kind: string;
  id: string;
  data: unknown;
  version: number;
}

/** Shared entity rows (store/sync.ts). Absent in memory mode. */
export interface EntityStore {
  /** Rows changed after `sinceMs` (database clock; null = all), the reset generation, and the database's clock. */
  load(sinceMs: number | null): Promise<{ generation: number; nowMs: number; rows: EntityRow[] }>;
  /** Upserts; null when the world was reset since `generation` (nothing written). */
  save(generation: number, rows: { kind: string; id: string; data: unknown }[]): Promise<{ kind: string; id: string; version: number }[] | null>;
  /** Drops every entity and starts a new generation. */
  reset(): Promise<number>;
}

export interface WorldStore {
  readonly persistence: "memory" | "postgres";
  readonly balances: BalanceStore;
  readonly entities: EntityStore | null;
  /** (2026-10-19) Cross-instance claims (store/leases.ts); absent in memory mode (the app keeps them in memory). */
  readonly leases?: Leases;
}
