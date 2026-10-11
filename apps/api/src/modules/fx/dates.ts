/*
 * Calendar helpers on ISO 8601 calendar dates (`YYYY-MM-DD`, UTC). Business days = Monday–Friday
 * (ISO 8601 weekday 1–5); public holidays are ignored, which the ±1 business-day tolerance absorbs.
 */

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function parseIsoDate(s: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new RangeError(`not an ISO date: ${s}`);
  return new Date(`${s}T00:00:00.000Z`);
}

export function addDays(date: string, days: number): string {
  const d = parseIsoDate(date);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDate(d);
}

export function isBusinessDay(date: string): boolean {
  const wd = parseIsoDate(date).getUTCDay();
  return wd !== 0 && wd !== 6;
}

/** n > 0: the n-th business day after `date`; n < 0: before. */
export function addBusinessDays(date: string, n: number): string {
  let d = date;
  const step = n < 0 ? -1 : 1;
  let left = Math.abs(n);
  while (left > 0) {
    d = addDays(d, step);
    if (isBusinessDay(d)) left--;
  }
  return d;
}

/** Whole days from a to b (b − a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((parseIsoDate(b).getTime() - parseIsoDate(a).getTime()) / 86_400_000);
}

/** True when `rateDate` is within ±1 business day of `wanted` (spec §12). */
export function withinOneBusinessDay(wanted: string, rateDate: string): boolean {
  return rateDate >= addBusinessDays(wanted, -1) && rateDate <= addBusinessDays(wanted, 1);
}
