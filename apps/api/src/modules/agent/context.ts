/*
 * (2026-10-20) What the planner needs for an ordinary conversation and that no tool returns: the date, weekday and
 * time where the user is, their language and home currency. Without it the model guessed "today" from its training
 * data. The date comes from Kassa's clock (clock/index.ts), so it follows the demo clock like due dates and budgets.
 */
import { clock } from "../clock/index.ts";
import { DEFAULT_DEVICE_TZ } from "../capture/tz.ts";

export type TurnContext = {
  /** IANA zone from the device (AgentMessageRequest.timeZone); invalid or missing → the server's default zone. */
  timeZone?: string | undefined;
  /** UI language (BCP 47), e.g. "ru", "kk", "zh-CN". */
  locale?: string | undefined;
  homeCurrency?: string | undefined;
  region?: string | undefined;
};

const LANGUAGES: Record<string, string> = { en: "English", ru: "Russian", kk: "Kazakh", zh: "Chinese" };

/** `zone` when Intl knows it, else null. */
export function validTimeZone(zone: string | undefined): string | null {
  if (!zone) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return null;
  }
}

/** "UTC+05:00" for `zone` at `at`. */
function utcOffset(at: Date, zone: string): string {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" })
    .formatToParts(at)
    .find((p) => p.type === "timeZoneName")?.value;
  return !name || name === "GMT" ? "UTC+00:00" : name.replace("GMT", "UTC");
}

/** The instructions block appended to the system prompt for one turn. */
export function contextPrompt(c: TurnContext, now: Date = clock.now()): string {
  const zone = validTimeZone(c.timeZone) ?? DEFAULT_DEVICE_TZ;
  const at = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-GB", { timeZone: zone, ...opts }).format(now);
  const date = at({ weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const time = at({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const isoDay = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const lang = c.locale ? (LANGUAGES[c.locale.slice(0, 2).toLowerCase()] ?? c.locale) : null;
  const lines = [
    `- Now: ${date}, ${time} (${isoDay}), time zone ${zone} (${utcOffset(now, zone)}). Use this for "today", "tomorrow", "this week", "this month", weekdays and how long until a date; never guess the date. When asked the date or time, answer from this.`,
    ...(lang ? [`- The app is set to ${lang}. Reply in the language of the user's message; if it is unclear, use ${lang}.`] : ["- Reply in the language of the user's message."]),
    ...(c.homeCurrency ? [`- Home currency: ${c.homeCurrency}${c.region ? `; region: ${c.region}` : ""}.`] : []),
  ];
  return `Context for this turn (from the system, not from the user):\n${lines.join("\n")}

Conversation:
- Greetings, thanks and small talk get a short, friendly answer with no tool calls; you may offer one thing you can help with.
- "What can you do?": you check balances, bills, budgets and spending, compare payment routes and exchange rates, read documents the user forwards, and prepare payments that the user signs with their passkey. You cannot browse the internet or see news, and you never pay without the system's rules and the user's approval.
- Questions outside money (general knowledge, maths, wording) get a brief answer from what you know, without tools, marked as general knowledge when it could be out of date.`;
}
