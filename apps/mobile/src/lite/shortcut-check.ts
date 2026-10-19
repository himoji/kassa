/**
 * KassaLite's Apple Pay setup (docs/guide/kassalite.md, "Shortcut setup"): the one link a hand-built Shortcut needs
 * (endpoint with the key in it), the ready-made Shortcut's iCloud link when one is published, the app's own connection check (POST /capture/shortcut `{test: true}` with that key;
 * nothing is logged or recorded), the tap check that reads what the last request carried (GET /devices
 * `lastCheck`), and the text for an AI assistant to walk someone through the automation.
 */
import { storage } from "@/lib/storage";

import { shortcutEndpointFor, voiceEndpointFor } from "./server-url";

const STARTED_KEY = "kassalite:shortcutSetup.v2";
const OLD_PROGRESS_KEY = "kassalite:shortcutSetup.v1";

/** The person tapped "Set up" on this iPhone: the card then waits for the first tap instead of offering setup. */
export async function loadSetupStarted(): Promise<boolean> {
  try {
    return (await storage.getItem(STARTED_KEY)) === "1";
  } catch {
    return false;
  }
}

export async function saveSetupStarted(): Promise<void> {
  try {
    await storage.setItem(STARTED_KEY, "1");
  } catch {
    // Only costs showing the setup button again; the server state decides the rest.
  }
}

export async function clearSetupProgress(): Promise<void> {
  try {
    await storage.removeItem(STARTED_KEY);
    await storage.removeItem(OLD_PROGRESS_KEY);
  } catch {
    // ignore
  }
}

/** `https://<server>/api/capture/shortcut?key=<token>`: the only value a hand-built Shortcut needs pasted. */
export function shortcutUrlWithKey(serverUrl: string, token: string): string {
  return `${shortcutEndpointFor(serverUrl)}?key=${encodeURIComponent(token)}`;
}

/** `https://<server>/api/capture/voice?key=<token>`: the one value the voice Shortcut needs pasted. */
export function voiceUrlWithKey(serverUrl: string, token: string): string {
  return `${voiceEndpointFor(serverUrl)}?key=${encodeURIComponent(token)}`;
}

/**
 * The published ready-made Shortcut (docs/guide/shortcuts.md, "The ready-made Shortcut"): an iCloud link set at bundle
 * time with `EXPO_PUBLIC_KASSALITE_SHORTCUT_URL`, so an over-the-air update can add or change it. Its one import
 * question takes the link `shortcutUrlWithKey` puts on the clipboard; the key is never part of the iCloud link.
 * Null when unset or not an iCloud Shortcuts link: setup then copies the link for a hand-built Shortcut.
 */
export function readyShortcutLink(
  raw: string | undefined = process.env.EXPO_PUBLIC_KASSALITE_SHORTCUT_URL
): string | null {
  const url = raw?.trim();
  if (!url) return null;
  return /^https:\/\/(www\.)?icloud\.com\/shortcuts\/[A-Za-z0-9]+\/?$/.test(url) ? url : null;
}

export type ConnectionCheck = "ok" | "revoked" | "unreachable" | "failed";

/**
 * POST `{test: true}` to the Shortcut endpoint with the Shortcut's token, as the Shortcut would. "revoked": 401
 * (token revoked or from another server); "unreachable": no HTTPS answer (tunnel or Mac down, wrong host).
 */
export async function checkShortcutConnection(
  serverUrl: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 10_000
): Promise<ConnectionCheck> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(shortcutEndpointFor(serverUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ test: true }),
      signal: controller.signal,
    });
    if (res.status === 401) return "revoked";
    if (!res.ok) return "failed";
    const body = (await res.json().catch(() => null)) as { status?: unknown } | null;
    return body?.status === "TEST" ? "ok" : "failed";
  } catch {
    return "unreachable";
  } finally {
    clearTimeout(timer);
  }
}

/** GET /devices `lastCheck`: what the last request from a Shortcut (or the action) carried. */
export type TapCheck = {
  at: string;
  kind: "TEST" | "PAYMENT" | "FORWARDED" | "INCOMPLETE";
  via: "action" | "shortcut";
  fields: { merchant: boolean; amount: boolean; card: boolean; place: boolean };
  status: "LOGGED" | "MERGED" | "IGNORED_INCOMING" | "UNPARSED" | null;
  transactionId: string | null;
};

export type CheckLine = {
  key: "reached" | "merchant" | "amount" | "card" | "place" | "logged";
  /** ok: right; fix: wrong, must change; tip: missing but optional. */
  state: "ok" | "fix" | "tip";
};

/**
 * The tap check, line by line: did the tap reach Kassa, did the automation send each Transaction field, and did
 * Kassa log it. Merchant, amount and the log are required; card and place are optional.
 */
export function tapCheckLines(check: TapCheck): CheckLine[] {
  const forwarded = check.kind === "FORWARDED";
  const lines: CheckLine[] = [
    { key: "reached", state: "ok" },
    { key: "merchant", state: check.fields.merchant ? "ok" : "fix" },
    { key: "amount", state: check.fields.amount && check.status !== "UNPARSED" ? "ok" : "fix" },
  ];
  if (!forwarded) {
    lines.push({ key: "card", state: check.fields.card ? "ok" : "tip" });
    lines.push({ key: "place", state: check.fields.place ? "ok" : "tip" });
  }
  const logged =
    check.status === "LOGGED" || check.status === "MERGED" || check.status === "IGNORED_INCOMING";
  lines.push({ key: "logged", state: logged ? "ok" : "fix" });
  return lines;
}

/** A real tap (not a test run) has reached Kassa and every required line is right. */
export function tapCheckPassed(check: TapCheck): boolean {
  return check.kind !== "TEST" && tapCheckLines(check).every((l) => l.state !== "fix");
}

/**
 * Text to paste into an AI assistant (ChatGPT, Siri with Apple Intelligence…) so it walks the person through
 * the automation. Never contains the key: the person pastes the copied link into Shortcuts themselves.
 */
export function aiSetupPrompt(viaAction: boolean): string {
  const common = [
    "Help me build an automation in the iPhone Shortcuts app (iOS 26). Walk me through it one tap at a time, tell me exactly what to tap, and wait for me to say “done” after each step.",
    "",
    "Goal: every time I pay with Apple Pay, the automation sends the payment to my Kassa budgeting app.",
    "",
    "1. Shortcuts app → Automation tab → + (top right) → Transaction.",
    "2. Card: select all my Wallet cards. Leave Merchant and Category as Any. Choose “Run Immediately” and turn off “Notify When Run”. Tap Next → New Blank Automation.",
  ];
  const steps = viaAction
    ? [
        "3. Tap Add Action, search for “Log Payment in Kassa” (from the KassaLite app) and add it.",
        "4. In that action: tap Merchant → Select Variable → Shortcut Input, then tap the Shortcut Input chip and choose Merchant. Do the same for Amount (choose Amount) and Card (choose Card or Pass). Leave Show Notification on.",
        "5. Optional, so it also says where I paid: add “Get Current Location” above it, then set Street, City and Country in the Kassa action to the matching Current Location details.",
        "6. Tap Done (top right).",
        "",
        "There is no URL or password to enter: the KassaLite app handles that.",
      ]
    : [
        "3. Add the action “Get Contents of URL”. Tap its URL field and paste (I have the link on my clipboard from KassaLite; do not ask me to type or share it, it contains a private key).",
        "4. Tap the › arrow on that action: set Method to POST and Request Body to JSON. Add three Text fields: key “merchant” = Shortcut Input › Merchant, key “amount” = Shortcut Input › Amount, key “card” = Shortcut Input › Card or Pass. (To pick these: tap the value, Select Variable → Shortcut Input, then tap the chip and choose the detail.)",
        "5. Add “Get Dictionary Value”: Get Value for key “nudge” in Contents of URL.",
        "6. Add “Show Notification” and set its text to Dictionary Value.",
        "7. Optional, so it also says where I paid: add “Get Current Location” at the top and add Text fields “street”, “city”, “country” to the JSON body from Current Location.",
        "8. Tap Done (top right).",
      ];
  return [
    ...common,
    ...steps,
    "",
    "Then I pay once with Apple Pay and open KassaLite → Settings: it checks that every field arrived. If it reports a problem, help me fix that field.",
  ].join("\n");
}
