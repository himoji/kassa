import { parseAmountString } from "../amount.ts";
import { zonedToUtc } from "../tz.ts";
import type { TextParser } from "./types.ts";

/*
 * WeChat Pay-style receipt (zh-CN), Asia/Shanghai time:
 *   支付成功
 *   ¥45.00
 *   收款方：面馆(示例)
 *   支付时间：2026年10月26日 18:20:11
 */

const AMOUNT = /[¥￥]\s*([\d,]+(?:\.\d{1,2})?)/;
const PAYEE = /(?:收款方|商户名称|商户)\s*[：:]\s*(.+)/;

export const wechatParser: TextParser = {
  format: "WECHAT_PAY",
  matches: (t) => /支付成功|微信支付/.test(t) && PAYEE.test(t),
  parse(text) {
    const a = AMOUNT.exec(text);
    const p = PAYEE.exec(text);
    if (!a || !p) return null;
    const t = /(\d{4})年(\d{1,2})月(\d{1,2})日\s*(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(text);
    const occurredAt = t ? zonedToUtc(+t[1]!, +t[2]!, +t[3]!, +t[4]!, +t[5]!, +(t[6] ?? 0), "Asia/Shanghai") : null;
    return { format: "WECHAT_PAY", kind: "PURCHASE", merchantRaw: p[1]!.trim(), amountMinor: parseAmountString(a[1]!, "CNY", "dot"), currency: "CNY", cardHint: null, occurredAt };
  },
};
