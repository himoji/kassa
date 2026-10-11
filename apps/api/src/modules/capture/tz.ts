/*
 * Wall-clock time in an IANA time zone → UTC instant (RFC 3339 output). Notifications print local time
 * without an offset; the parser knows the app's zone (KZ banks: Asia/Almaty, UTC+05:00 since
 * 2024-03-01; CN wallets: Asia/Shanghai; EN apps and Shortcuts: the device zone). Uses the IANA tz
 * database via Intl, so DST (e.g. Europe/Budapest on 2026-10-25) is handled.
 */

function offsetMs(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const wall = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return wall - Math.floor(utcMs / 1000) * 1000;
}

export function zonedToUtc(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  s: number,
  timeZone: string,
): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  let t = guess - offsetMs(guess, timeZone);
  // Second pass fixes guesses that straddle a DST transition.
  t = guess - offsetMs(t, timeZone);
  return new Date(t);
}

/** Default device zone for EN apps / Shortcuts (hero user lives in Budapest, spec §1). */
export const DEFAULT_DEVICE_TZ = process.env.DEVICE_TZ ?? "Europe/Budapest";

export const MONTHS_EN: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
