import { sameCardCharge, type BalanceStore, type CardDebitRecord, type CardDebitResult, type SeedWallet, type TopUpResult, type WorldStore } from "./types.ts";

/*
 * (added 2026-10-18) In-memory state: local development and tests. Resets on restart and on POST /mock/reset.
 * Single process, so "atomic" just means no await between the check and the change.
 */

export class MemoryBalanceStore implements BalanceStore {
  private wallets = new Map<number, Map<string, number>>();
  private readonly aliases = new Map<string, number>();
  private readonly topUps = new Map<string, { profile: number; currency: string; amountMinor: number; balanceAfterMinor: number }>();
  /** Card debits by reference, and the reference per card (a card is debited once). */
  private readonly cardDebits = new Map<string, CardDebitRecord>();
  private readonly cardDebitByCard = new Map<string, string>();
  private next: number;

  constructor(
    private readonly seeds: SeedWallet[],
    idStart: number = 50_000_000 + (Math.floor(Date.now() / 1000) % 10_000_000) * 10,
  ) {
    this.next = idStart;
    for (const s of seeds) this.alias(s.profileId, s.aliases ?? []);
    this.restoreSeeds();
  }

  private alias(profile: number, aliases: string[]): void {
    this.aliases.set(String(profile), profile);
    for (const a of aliases) this.aliases.set(a.toLowerCase(), profile);
  }

  private restoreSeeds(): void {
    this.wallets = new Map(this.seeds.map((s) => [s.profileId, new Map(s.balances.map((b) => [b.currency, b.amountMinor]))]));
  }

  async resolve(alias: string): Promise<number | undefined> {
    return this.aliases.get(alias.toLowerCase());
  }

  async hasWallet(profile: number): Promise<boolean> {
    return this.wallets.has(profile);
  }

  async openWallet(profile: number, aliases: string[]): Promise<boolean> {
    const created = !this.wallets.has(profile);
    if (created) this.wallets.set(profile, new Map());
    this.alias(profile, aliases);
    return created;
  }

  async balances(profile: number): Promise<[string, number][] | null> {
    const w = this.wallets.get(profile);
    return w ? [...w.entries()] : null;
  }

  async credit(profile: number, currency: string, amountMinor: number): Promise<number | null> {
    const w = this.wallets.get(profile);
    if (!w) return null;
    const next = (w.get(currency) ?? 0) + amountMinor;
    w.set(currency, next);
    return next;
  }

  async debit(profile: number, currency: string, amountMinor: number): Promise<number | null> {
    const w = this.wallets.get(profile);
    const available = w?.get(currency) ?? 0;
    if (!w || available < amountMinor) return null;
    w.set(currency, available - amountMinor);
    return available - amountMinor;
  }

  async topUp(reference: string, profile: number, currency: string, amountMinor: number): Promise<TopUpResult> {
    const seen = this.topUps.get(reference);
    if (seen) {
      if (seen.profile !== profile || seen.currency !== currency || seen.amountMinor !== amountMinor) return { kind: "conflict" };
      return { kind: "ok", balanceAfterMinor: seen.balanceAfterMinor, created: false };
    }
    const balanceAfterMinor = await this.credit(profile, currency, amountMinor);
    if (balanceAfterMinor === null) return { kind: "no_wallet" };
    this.topUps.set(reference, { profile, currency, amountMinor, balanceAfterMinor });
    return { kind: "ok", balanceAfterMinor, created: true };
  }

  private findCardDebitNow(reference: string, cardId: string): CardDebitRecord | null {
    const ref = this.cardDebits.has(reference) ? reference : this.cardDebitByCard.get(cardId);
    return ref !== undefined ? (this.cardDebits.get(ref) ?? null) : null;
  }

  async findCardDebit(reference: string, cardId: string): Promise<CardDebitRecord | null> {
    return this.findCardDebitNow(reference, cardId);
  }

  // No await between the lookup, the debit and the record: atomic in this single process.
  async cardDebit(d: Omit<CardDebitRecord, "balanceAfterMinor">): Promise<CardDebitResult> {
    const seen = this.findCardDebitNow(d.reference, d.cardId);
    if (seen) return sameCardCharge(seen, d) ? { kind: "ok", debit: seen, created: false } : { kind: "conflict" };
    const w = this.wallets.get(d.profile);
    const available = w?.get(d.currency) ?? 0;
    if (!w || available < d.amountMinor) return { kind: "insufficient" };
    w.set(d.currency, available - d.amountMinor);
    const debit: CardDebitRecord = { ...d, balanceAfterMinor: available - d.amountMinor };
    this.cardDebits.set(d.reference, debit);
    this.cardDebitByCard.set(d.cardId, d.reference);
    return { kind: "ok", debit, created: true };
  }

  /** Nothing can wipe this store from outside. */
  async seed(): Promise<void> {}

  async nextId(): Promise<number> {
    return this.next++;
  }

  /** Seeded wallets only; ids keep increasing, aliases stay (as before: a re-opened wallet keeps its ids). */
  async reset(): Promise<void> {
    this.topUps.clear();
    this.cardDebits.clear();
    this.cardDebitByCard.clear();
    this.restoreSeeds();
  }
}

export function memoryStore(seeds: SeedWallet[], idStart?: number): WorldStore {
  return { persistence: "memory", balances: new MemoryBalanceStore(seeds, idStart), entities: null };
}
