import { parseAmountString } from "../amount.ts";
import { zonedToUtc } from "../tz.ts";
import type { TextParser } from "./types.ts";

/*
 * Alipay-style wallet notice (zh-CN), Asia/Shanghai time:
 *   交易提醒
 *   你在 便利店(示例) 消费 ¥32.50
 *   付款方式：余额
 *   交易时间：2026-10-26 12:30:41
 * Also the bank-SMS variant "…尾号1234…在<商户>消费35.50元".
 */

const SPEND = /在\s*(.+?)\s*消费\s*(?:[¥￥]\s*([\d,]+(?:\.\d{1,2})?)|([\d,]+(?:\.\d{1,2})?)\s*元)/;
const PAY_TO = /付款\s*[¥￥]\s*([\d,]+(?:\.\d{1,2})?)\s*给\s*(.+)/;

export const alipayParser: TextParser = {
  format: "ALIPAY",
  matches: (t) => SPEND.test(t) || PAY_TO.test(t) || /交易提醒/.test(t),
  parse(text) {
    let merchantRaw: string | null = null;
    let amount: string | undefined;
    const s = SPEND.exec(text);
    if (s) {
      merchantRaw = s[1]!.trim();
      amount = s[2] ?? s[3];
    } else {
      const p = PAY_TO.exec(text);
      if (p) {
        amount = p[1];
        merchantRaw = p[2]!.trim();
      }
    }
    if (!amount) return null;
    const card = /尾号\s*(\d{4})/.exec(text)?.[1] ?? null;
    const t = /(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(text);
    const occurredAt = t ? zonedToUtc(+t[1]!, +t[2]!, +t[3]!, +t[4]!, +t[5]!, +(t[6] ?? 0), "Asia/Shanghai") : null;
    return { format: "ALIPAY", kind: "PURCHASE", merchantRaw, amountMinor: parseAmountString(amount, "CNY", "dot"), currency: "CNY", cardHint: card, occurredAt };
  },
};
