/**
 * Push notifications on expo-notifications (push/expo-notifications module).
 *
 * Same surface as the core shim (`src/lib/shims/push.ts`): `push.usePushToken()`,
 * `push.requestPermission()` and `push.sendTestNotification()`. `PushProvider` (order 80) sets the
 * foreground presentation handler, creates the Android `default` channel and
 * turns a tapped notification with `data.url` into `router.push(url)`.
 *
 * Remote push needs a dev build on a physical device with `eas init` done;
 * local notifications (`scheduleNotificationAsync`) also work in Expo Go.
 */
import * as Notifications from "expo-notifications";
import { router, type Href } from "expo-router";
import { useEffect, type ReactNode } from "react";
import { Platform } from "react-native";

import { ensurePushStarted, requestPushPermission, usePushToken } from "@/hooks/use-push-token";
import type { Push, PushTokenState, TestNotification } from "@/lib/shims/push";

export type { Push, PushTokenState, TestNotification };

/** Local notifications need permission only - no token, so the simulator and Expo Go work too. */
async function sendTestNotification(content: TestNotification, seconds = 3): Promise<boolean> {
  if (Platform.OS === "web") return false;
  if (!(await Notifications.getPermissionsAsync()).granted) {
    // Through the hook's flow, so `usePushToken()` picks up the new permission as well.
    await requestPushPermission();
    if (!(await Notifications.getPermissionsAsync()).granted) return false;
  }
  await Notifications.scheduleNotificationAsync({
    content,
    trigger: { type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL, seconds },
  });
  return true;
}

export const push: Push = {
  usePushToken,
  requestPermission: requestPushPermission,
  sendTestNotification,
};

/** Foreground presentation: banner + notification list + sound, no badge. */
const FOREGROUND_BEHAVIOR: Notifications.NotificationBehavior = {
  shouldShowBanner: true,
  shouldShowList: true,
  shouldPlaySound: true,
  shouldSetBadge: false,
};

/** Deep-link target carried in a notification's `data.url`, if any. */
export function notificationUrl(response: Notifications.NotificationResponse): string | null {
  const url = response.notification.request.content.data?.url;
  return typeof url === "string" && url.length > 0 ? url : null;
}

/** Route to `data.url` of a tapped notification. Exported for tests. */
export function handleNotificationResponse(response: Notifications.NotificationResponse) {
  const url = notificationUrl(response);
  if (!url) return;
  try {
    router.push(url as Href);
  } catch (err) {
    console.warn("[push] could not open notification url", url, err);
  }
}

/**
 * Provider (order 80). Registers the handler + listeners for the app's
 * lifetime and handles the response that cold-started the app.
 */
export function PushProvider({ children }: { children?: ReactNode }) {
  useEffect(() => {
    if (Platform.OS === "web") return;

    Notifications.setNotificationHandler({ handleNotification: async () => FOREGROUND_BEHAVIOR });

    if (Platform.OS === "android") {
      Notifications.setNotificationChannelAsync("default", {
        name: "Default",
        importance: Notifications.AndroidImportance.DEFAULT,
      }).catch((err: unknown) => console.warn("[push] channel setup failed", err));
    }

    const received = Notifications.addNotificationReceivedListener((notification) => {
      if (__DEV__) console.log("[push] received", notification.request.content.title);
    });
    // Keyed by request id + action so a cold-start response handled below is not routed twice.
    let handled: string | null = null;
    const respond = (response: Notifications.NotificationResponse) => {
      const key = `${response.notification.request.identifier}:${response.actionIdentifier}`;
      if (key === handled) return;
      handled = key;
      handleNotificationResponse(response);
    };
    const responded = Notifications.addNotificationResponseReceivedListener(respond);
    Notifications.getLastNotificationResponseAsync()
      .then((last) => {
        if (last) respond(last);
      })
      .catch(() => {});

    ensurePushStarted();

    return () => {
      received.remove();
      responded.remove();
    };
  }, []);

  return children;
}
