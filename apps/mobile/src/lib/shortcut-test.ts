/**
 * The live Shortcut test (app/shortcut-test.tsx): what each request a Shortcut key made since the test started means,
 * and whether the whole path is proven. Only server evidence counts: a request that reached Kassa after "Start", from
 * the iOS Shortcuts app, carrying a merchant and an amount, logged as a purchase. The person then confirms what only
 * they can see (the amount is their purchase, the iPhone showed Kassa's notification). Nothing here passes on the
 * app's own connection check, which proves the server and the key but not the automation.
 */
import type { ShortcutAttempt } from "@/api/hooks/shortcut";

export type Tone = "ok" | "fix" | "info";

export type AttemptVerdict = {
  tone: Tone;
  /** Key under `shortcut:test.attempt.*`. */
  key:
    | "logged"
    | "forwarded"
    | "manualRun"
    | "noAmount"
    | "noMerchant"
    | "amountUnreadable"
    | "textUnreadable"
    | "revokedKey"
    | "badBody"
    | "failed";
};

/** A caller that is a browser or a script, not the iOS Shortcuts app or the KassaLite action. */
const SCRIPT_CLIENT =
  /^(Mozilla|curl|Wget|python|node|undici|Bun|axios|PostmanRuntime|okhttp|Go-http-client|insomnia|HTTPie)/i;

export function fromScript(a: Pick<ShortcutAttempt, "client" | "via">): boolean {
  return a.via !== "action" && !!a.client && SCRIPT_CLIENT.test(a.client);
}

export function attemptVerdict(a: ShortcutAttempt): AttemptVerdict {
  switch (a.kind) {
    case "REVOKED_KEY":
      return { tone: "fix", key: "revokedKey" };
    case "BAD_BODY":
      return { tone: "fix", key: "badBody" };
    case "FAILED":
      return { tone: "fix", key: "failed" };
    case "TEST":
      return { tone: "info", key: "manualRun" };
    case "INCOMPLETE":
      return { tone: "fix", key: "noAmount" };
    case "FORWARDED":
      return a.status === "UNPARSED"
        ? { tone: "fix", key: "textUnreadable" }
        : { tone: "ok", key: "forwarded" };
    case "PAYMENT":
      if (!a.fields.merchant) return { tone: "fix", key: "noMerchant" };
      if (!a.fields.amount) return { tone: "fix", key: "noAmount" };
      if (a.status === "UNPARSED") return { tone: "fix", key: "amountUnreadable" };
      return { tone: "ok", key: "logged" };
  }
}

/** The person's answers about the logged purchase: null until answered. */
export type Answers = { amountMatches: boolean | null; notificationShown: boolean | null };

export type TestState =
  /** Nothing has reached Kassa since the start (yet). */
  | { kind: "waiting" }
  /** The newest request was refused or incomplete: fix the named problem, then pay again. */
  | { kind: "fix"; attempt: ShortcutAttempt; verdict: AttemptVerdict }
  /** Only runs without a payment: URL and key work, the Apple Pay trigger is not proven. */
  | { kind: "manualOnly"; attempt: ShortcutAttempt }
  /** A purchase was logged, but from a browser or script: the automation is not proven. */
  | { kind: "notShortcuts"; attempt: ShortcutAttempt }
  /** A purchase was logged: the person confirms the amount and the notification. */
  | { kind: "confirm"; attempt: ShortcutAttempt }
  /** Logged, but the amount is not the purchase's. */
  | { kind: "wrongAmount"; attempt: ShortcutAttempt }
  /** Logged correctly, but the iPhone showed no notification. */
  | { kind: "noNotification"; attempt: ShortcutAttempt }
  /** Every step proven. */
  | { kind: "passed"; attempt: ShortcutAttempt };

/** Requests since `startedAt` (server time), newest first. */
export function attemptsSince(
  all: readonly ShortcutAttempt[] | undefined,
  startedAt: string
): ShortcutAttempt[] {
  return (all ?? []).filter((a) => a.at >= startedAt).sort((x, y) => y.at.localeCompare(x.at));
}

export function testState(since: readonly ShortcutAttempt[], answers: Answers): TestState {
  const newest = since[0];
  if (!newest) return { kind: "waiting" };
  const purchase = since.find((a) => a.kind === "PAYMENT" && attemptVerdict(a).tone === "ok");
  // A refusal after the last good purchase is the current problem (for example a key revoked during the test).
  const newestVerdict = attemptVerdict(newest);
  if (newestVerdict.tone === "fix" && (!purchase || newest.at > purchase.at))
    return { kind: "fix", attempt: newest, verdict: newestVerdict };
  if (!purchase) {
    const forwarded = since.find((a) => a.kind === "FORWARDED" && attemptVerdict(a).tone === "ok");
    if (forwarded) return answersState(forwarded, answers);
    return { kind: "manualOnly", attempt: newest };
  }
  if (fromScript(purchase)) return { kind: "notShortcuts", attempt: purchase };
  return answersState(purchase, answers);
}

function answersState(attempt: ShortcutAttempt, answers: Answers): TestState {
  if (answers.amountMatches === false) return { kind: "wrongAmount", attempt };
  if (answers.notificationShown === false) return { kind: "noNotification", attempt };
  if (answers.amountMatches && answers.notificationShown) return { kind: "passed", attempt };
  return { kind: "confirm", attempt };
}

/** After this long with nothing received, the screen lists why a tap may not reach Kassa. */
export const NOTHING_ARRIVED_AFTER_MS = 90_000;
