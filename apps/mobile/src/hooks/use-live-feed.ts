/**
 * Real-time feed: while the app is in the foreground and signed in, hold a long poll on GET /notifications/wait
 * (the API also runs as a Vercel Function, which cannot keep a WebSocket open). When the feed changes, money data
 * refetches everywhere, and money that arrived from someone else (another Kassa wallet, money from home) shows a
 * banner at once, without a pull or a screen change.
 *
 * Remote push cannot cover this in KassaLite (free Apple IDs cannot sign the push entitlement), so this is the
 * channel in both builds; in the background the app catches up on its next foreground.
 */
import { NotificationsWaitResponse, type NotificationDto } from "@kassa/shared";
import { useEffect } from "react";
import { AppState, Platform } from "react-native";

import { api } from "@/api/client";
import { moneyKeys } from "@/api/keys";
import { toast } from "@/components/ui";
import { formatAmount } from "@/lib/format";
import { i18next } from "@/lib/i18n";
import { queryClient } from "@/lib/query";
import { notifyNow } from "@/lite/notifier";
import { notificationText } from "@/screens/activity/notification-text";
import { useSessionStore } from "@/stores/session";

/** Notifications about money someone else sent: these interrupt; everything else only refreshes the screens. */
export const BANNER_KINDS = new Set(["MONEY_RECEIVED", "MONEY_FROM_HOME"]);
/** A little over the server's 25 s hold, so the server answers before the client gives up. */
const WAIT_TIMEOUT_MS = 35_000;
const RETRY_MS = [2_000, 5_000, 15_000, 30_000];

/** New notifications in `next` that `seen` has not had; records them in `seen`. Exported for tests. */
export function freshNotifications(
  seen: Set<string>,
  next: readonly NotificationDto[]
): NotificationDto[] {
  const fresh = next.filter((n) => !seen.has(n.id));
  for (const n of fresh) seen.add(n.id);
  return fresh;
}

async function announce(n: NotificationDto): Promise<void> {
  const text = notificationText(n, i18next.t, (minor, currency) =>
    formatAmount(minor, currency, i18next.language)
  );
  if (
    Platform.OS === "web" ||
    !(await notifyNow(text.title, text.body, "/activity").catch(() => false))
  ) {
    toast.show({ title: text.title, description: text.body, kind: "success" });
  }
}

export function useLiveFeed(enabled: boolean): void {
  const authed = useSessionStore((s) => s.status) === "authenticated";
  useEffect(() => {
    if (!enabled || !authed) return;
    let controller: AbortController | null = null;
    let stopped = false;
    let cursor: string | undefined;
    // null until the first answer: what was already in the feed when the app opened never shows a banner.
    let seen: Set<string> | null = null;

    const loop = async () => {
      let failures = 0;
      while (!stopped && AppState.currentState === "active") {
        controller = new AbortController();
        try {
          const q = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
          const r = await api.request(`/notifications/wait${q}`, {
            schema: NotificationsWaitResponse,
            signal: controller.signal,
            timeoutMs: WAIT_TIMEOUT_MS,
          });
          failures = 0;
          const first = seen === null;
          seen ??= new Set();
          const fresh = freshNotifications(seen, r.notifications);
          if (r.changed && cursor !== undefined) {
            void Promise.all(
              moneyKeys.map((queryKey) => queryClient.invalidateQueries({ queryKey }))
            );
          }
          cursor = r.cursor;
          if (!first) for (const n of fresh) if (BANNER_KINDS.has(n.kind)) void announce(n);
        } catch {
          if (stopped) return;
          const wait = RETRY_MS[Math.min(failures++, RETRY_MS.length - 1)]!;
          await new Promise((resolve) => setTimeout(resolve, wait));
        }
      }
    };

    let running: Promise<void> | null = null;
    const start = () => {
      if (stopped || running) return;
      running = loop().finally(() => {
        running = null;
      });
    };
    start();
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") start();
      else controller?.abort();
    });
    return () => {
      stopped = true;
      sub.remove();
      controller?.abort();
    };
  }, [enabled, authed]);
}
