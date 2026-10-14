/**
 * Local notifications for purchases the Shortcut captured since the app last looked.
 * No push: free Apple IDs cannot sign the push entitlement, so KassaLite polls GET /capture/recent while
 * it is in the foreground and notifies from the app itself (`scheduleNotificationAsync`, trigger null).
 *
 * The watermark is the response's `serverTime`, persisted in the KV store. The first run only records it,
 * so installing the app never replays old purchases.
 */
import type { RecentCapture, RecentCapturesResponse } from "@kassa/shared";
import * as Notifications from "expo-notifications";
import { router, type Href } from "expo-router";
import { useEffect } from "react";

import { formatAmount } from "@/lib/format";
import { i18next } from "@/lib/i18n";
import { storage } from "@/lib/storage";

export const LAST_SEEN_KEY = "kassalite:lastSeenServerTime";
/** More than this many new purchases collapse into one summary notification. */
export const MAX_INDIVIDUAL_NOTIFICATIONS = 3;

/** Captures created strictly after `lastSeen` (ISO), oldest first. */
export function capturesSince(
  captures: readonly RecentCapture[],
  lastSeen: string
): RecentCapture[] {
  const since = Date.parse(lastSeen);
  return captures
    .filter((c) => Date.parse(c.createdAt) > since)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

let handlerSet = false;

async function canNotify(): Promise<boolean> {
  if (!handlerSet) {
    handlerSet = true;
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: true,
        shouldSetBadge: false,
      }),
    });
  }
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return true;
  if (!current.canAskAgain) return false;
  return (await Notifications.requestPermissionsAsync()).granted;
}

/** `data.url` is the in-app route a tap opens (useNotificationLinks). */
async function show(title: string, body: string, url: string): Promise<void> {
  await Notifications.scheduleNotificationAsync({
    content: { title, body, data: { url } },
    trigger: null,
  });
}

/** The route a purchase notification opens. */
export function purchaseUrl(id: string): string {
  return `/purchase/${encodeURIComponent(id)}`;
}

let chain: Promise<number> = Promise.resolve(0);

/**
 * Compare `response` with the stored watermark, notify for newer captures, advance the watermark.
 * Calls are serialised so two overlapping polls never notify the same purchase twice.
 * Resolves with the number of purchases that were new.
 */
export function notifyNewCaptures(response: RecentCapturesResponse): Promise<number> {
  chain = chain.then(
    () => run(response),
    () => run(response)
  );
  return chain;
}

async function run(response: RecentCapturesResponse): Promise<number> {
  const lastSeen = await storage.getItem(LAST_SEEN_KEY);
  if (!lastSeen) {
    await storage.setItem(LAST_SEEN_KEY, response.serverTime);
    return 0;
  }
  const fresh = capturesSince(response.captures, lastSeen);
  if (fresh.length > 0 && (await canNotify())) {
    if (fresh.length > MAX_INDIVIDUAL_NOTIFICATIONS) {
      await show(
        i18next.t("lite:activity.notifyManyTitle", { count: fresh.length }),
        i18next.t("lite:activity.notifyManyBody"),
        "/activity"
      );
    } else {
      for (const c of fresh) {
        await show(
          i18next.t("lite:activity.notifyTitle"),
          i18next.t("lite:activity.notifyBody", {
            merchant: c.place?.name ?? c.merchant,
            amount: formatAmount(c.amountMinor, c.currency, i18next.language),
          }),
          purchaseUrl(c.id)
        );
      }
    }
  }
  // Never move the watermark backwards (an older response arriving late).
  if (Date.parse(response.serverTime) > Date.parse(lastSeen)) {
    await storage.setItem(LAST_SEEN_KEY, response.serverTime);
  }
  return fresh.length;
}

export async function clearNotifierState(): Promise<void> {
  await storage.removeItem(LAST_SEEN_KEY);
}

/** Only app routes are followed (a notification's data is ours, but never trust it to leave the app). */
export function notificationRoute(response: Notifications.NotificationResponse): string | null {
  const url = response.notification.request.content.data?.url;
  return typeof url === "string" && url.startsWith("/") && !url.startsWith("//") ? url : null;
}

/**
 * Opens the route of a tapped purchase notification, including the one that launched the app. `enabled` waits for
 * the navigator and a paired session (a tap while locked opens the route behind the lock screen).
 */
export function useNotificationLinks(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    let handled: string | null = null;
    const open = (response: Notifications.NotificationResponse) => {
      const key = `${response.notification.request.identifier}:${response.actionIdentifier}`;
      if (key === handled) return;
      handled = key;
      const route = notificationRoute(response);
      if (route) router.push(route as Href);
    };
    const sub = Notifications.addNotificationResponseReceivedListener(open);
    Notifications.getLastNotificationResponseAsync()
      .then((last) => {
        if (!last) return;
        open(last);
        // Handled: a later relaunch must not open it again.
        Notifications.clearLastNotificationResponse();
      })
      .catch(() => {});
    return () => sub.remove();
  }, [enabled]);
}
