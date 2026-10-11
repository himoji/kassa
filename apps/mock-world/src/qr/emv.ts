import { fromMinor } from "@kassa/shared";

/*
 * Merchant-presented QR payload in the EMVCo QR Code Specification for Payment Systems (EMV QRCPS)
 * Merchant-Presented Mode layout: TLV with 2-digit id, 2-digit decimal length, value; CRC (id 63)
 * is CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF) over the whole string including "6304",
 * printed as 4 upper-case hex digits. Currency is the ISO 4217 numeric code; country ISO 3166-1
 * alpha-2. The payload is simulated: it names a fictitious wallet GUI, not a real scheme.
 */

export const ISO4217_NUMERIC: Record<string, string> = {
  CNY: "156",
  EUR: "978",
  HUF: "348",
  KZT: "398",
  USD: "840",
};

function tlv(id: string, value: string): string {
  if (value.length > 99) throw new RangeError(`EMV field ${id} longer than 99`);
  return `${id}${String(value.length).padStart(2, "0")}${value}`;
}

/** CRC-16/CCITT-FALSE. Check value for "123456789" is 0x29B1. */
export function crc16ccitt(input: string): string {
  let crc = 0xffff;
  for (const byte of new TextEncoder().encode(input)) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

/** EMV names are limited to the Alphanumeric Special set; keep printable ASCII only. */
function ascii(value: string, max: number): string {
  return value
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]/g, "")
    .slice(0, max);
}

export interface EmvInput {
  paymentId: string;
  merchantName: string;
  merchantCity: string;
  countryCode: string;
  mcc: string;
  currency: string;
  amountMinor: number;
  reference: string | null;
}

export function buildEmvPayload(input: EmvInput): string {
  const numeric = ISO4217_NUMERIC[input.currency];
  if (!numeric) throw new RangeError(`No ISO 4217 numeric code for ${input.currency}`);
  const merchantAccount = tlv("00", "demo.kassa.qrwallet") + tlv("01", input.paymentId);
  let body =
    tlv("00", "01") + // payload format indicator
    tlv("01", "12") + // point of initiation: dynamic (one payment)
    tlv("26", merchantAccount) +
    tlv("52", input.mcc) +
    tlv("53", numeric) +
    tlv("54", fromMinor(input.amountMinor, input.currency)) +
    tlv("58", input.countryCode) +
    tlv("59", ascii(input.merchantName, 25)) +
    tlv("60", ascii(input.merchantCity, 15));
  if (input.reference) body += tlv("62", tlv("05", ascii(input.reference, 25)));
  const withCrcId = `${body}6304`;
  return withCrcId + crc16ccitt(withCrcId);
}

/** Parse top-level TLVs and verify the CRC. Used by tests and the wallet page. */
export function parseEmvPayload(payload: string): { fields: Record<string, string>; crcValid: boolean } {
  const fields: Record<string, string> = {};
  let i = 0;
  while (i + 4 <= payload.length) {
    const id = payload.slice(i, i + 2);
    const len = Number(payload.slice(i + 2, i + 4));
    if (!Number.isInteger(len)) break;
    fields[id] = payload.slice(i + 4, i + 4 + len);
    i += 4 + len;
  }
  const crcValid = fields["63"] !== undefined && crc16ccitt(payload.slice(0, -4)) === fields["63"];
  return { fields, crcValid };
}
