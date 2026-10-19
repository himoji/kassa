/*
 * The due window (spec §15): a bill is "due" when its period (due date) is no later than today + DUE_WINDOW_DAYS
 * (UTC calendar days on the Clock). One definition for the scheduler (which proposes only due bills), the rules
 * (mandate AUTO only for a due bill, else ASK MANDATE_NOT_DUE_YET) and payments' own mandate check, so the agent
 * cannot pay a mandate bill earlier than the scheduler would. A leaf module: no imports beyond the clock helpers.
 */
import { addMs, DAY_MS, isoDate } from "../clock/index.ts";

export const DUE_WINDOW_DAYS = 3;

/** The last due date (ISO 8601) inside the window at `now`. */
export function dueHorizon(now: Date): string {
  return isoDate(addMs(now, DUE_WINDOW_DAYS * DAY_MS));
}

/** ISO 8601 date + n calendar months, day clamped to the month's length. */
export function addMonths(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return isoDate(target);
}
