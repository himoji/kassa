/** No-op push notifications (contract 5). Replaced by the selected push module. */

export interface PushTokenState {
  /** Expo push token once `status` is `granted`, otherwise `null`. */
  token: string | null;
  status: "unsupported" | "loading" | "denied" | "granted";
}

export interface Push {
  usePushToken(): PushTokenState;
  /**
   * Prompts for notification permission; resolves `true` when granted - enough for
   * local notifications even where `usePushToken()` reports `unsupported` (simulator,
   * no EAS project), since a remote token needs more than permission.
   */
  requestPermission(): Promise<boolean>;
  /**
   * Schedules a local notification `seconds` from now (default 3), asking for permission
   * first when needed; resolves `false` when it is not allowed (or on web). For Settings →
   * Developer tools. Optional: the shim cannot notify and leaves it out.
   */
  sendTestNotification?(content: TestNotification, seconds?: number): Promise<boolean>;
}

export interface TestNotification {
  title: string;
  body: string;
}

const NO_TOKEN: PushTokenState = { token: null, status: "unsupported" };

export const push: Push = {
  usePushToken: () => NO_TOKEN,
  requestPermission: () => Promise.resolve(false),
};
