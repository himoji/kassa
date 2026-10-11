export type ParserFormat = "KZ_BANK" | "ALIPAY" | "WECHAT_PAY" | "REVOLUT" | "WISE" | "IOS_SHORTCUT";

export type EventKind = "PURCHASE" | "INCOMING" | "REFUND";

/** Deterministic parse of one notification (spec §13 step 1). Amounts in minor units. */
export interface ParsedEvent {
  format: ParserFormat;
  kind: EventKind;
  merchantRaw: string | null;
  amountMinor: number;
  currency: string;
  cardHint: string | null;
  /** Null when the notification has no time: the caller uses Clock.now(). */
  occurredAt: Date | null;
  /** Location parts printed after the merchant (city / ISO 3166-1 alpha-2 country), when present. */
  location?: { city?: string; country?: string };
}

export interface TextParser {
  format: ParserFormat;
  /** Cheap check: does this text look like this app's format? */
  matches(text: string): boolean;
  /** Returns null when the text matches the format but cannot be parsed fully (→ Reader fallback). */
  parse(text: string, opts?: { deviceTimeZone?: string }): ParsedEvent | null;
}
