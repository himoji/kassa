import { alipayParser } from "./alipay.ts";
import { kzBankParser } from "./kzBank.ts";
import { revolutParser, wiseParser } from "./revolutWise.ts";
import type { ParsedEvent, TextParser } from "./types.ts";
import { wechatParser } from "./wechat.ts";

export * from "./types.ts";
export { parseShortcut, ShortcutPayload } from "./shortcut.ts";
export { ForwardedNotification, parseWalletNotification } from "./wallet.ts";

/** Order matters only for overlapping formats; WeChat before Alipay (both use ¥). */
export const TEXT_PARSERS: TextParser[] = [kzBankParser, wechatParser, alipayParser, wiseParser, revolutParser];

/** Spec §13 step 1: deterministic parsers first. Null → caller falls back to the Reader. */
export function parseNotificationText(text: string, opts?: { deviceTimeZone?: string }): ParsedEvent | null {
  for (const p of TEXT_PARSERS) {
    if (!p.matches(text)) continue;
    try {
      const r = p.parse(text, opts);
      if (r && r.amountMinor > 0) return r;
    } catch {
      // A format match with an unparsable body falls through to the next parser / the Reader.
    }
  }
  return null;
}
