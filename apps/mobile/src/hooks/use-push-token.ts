/**
 * Expo push token state machine (push/expo-notifications module).
 *
 * A module-level store (no provider needed) so `usePushToken()` is safe in
 * any screen - including tests that render without `<PushProvider>` - and
 * `push.requestPermission()` updates every subscriber.
 *
 *   loading ──► unsupported   web · simulator/emulator · no EAS project id
 *           ──► denied        permission not granted (or not yet asked)
 *           ──► granted       token from `getExpoPushTokenAsync({ projectId })`
 *
 * The last good token is persisted under `readynative:push-token` through the
 * storage adapter so an offline start can still show it.
 */
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { useEffect, useSyncExternalStore } from "react";
import { Platform } from "react-native";

import type { PushTokenState } from "@/lib/shims/push";
import { storage } from "@/lib/storage";

export const PUSH_TOKEN_KEY = "readynative:push-token";

const listeners = new Set<() => void>();
let state: PushTokenState = { token: null, status: "loading" };
let started = false;

function setState(next: PushTokenState) {
  if (next.status === state.status && next.token === state.token) return;
  state = next;
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot() {
  return state;
}

/** EAS project id: app.config.ts `extra.eas.projectId`, from readynative.config.ts `app.easProjectId` / EAS_PROJECT_ID. */
export function getProjectId(): string | undefined {
  const id = Constants.expoConfig?.extra?.eas?.projectId as unknown;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/**
 * Why remote push cannot work here, or `null` when it can. Local
 * notifications still work in every case except web.
 */
export function unsupportedReason(): string | null {
  if (Platform.OS === "web") return "web";
  if (!Device.isDevice) return "simulator";
  if (!getProjectId()) return "no-project-id";
  return null;
}

function warnUnsupported(reason: string) {
  if (!__DEV__) return;
  if (reason === "no-project-id") {
    console.warn(
      "[push] extra.eas.projectId is empty - set app.easProjectId in readynative.config.ts (the id `eas init` prints); remote push is disabled until then."
    );
  } else if (reason === "simulator") {
    console.warn("[push] remote push needs a physical device; simulators never get a token.");
  }
}

async function fetchToken(projectId: string): Promise<string | null> {
  try {
    const { data } = await Notifications.getExpoPushTokenAsync({ projectId });
    await storage.setItem(PUSH_TOKEN_KEY, data).catch(() => {});
    return data;
  } catch (err) {
    console.warn("[push] getExpoPushTokenAsync failed, using cached token if any", err);
    return storage.getItem(PUSH_TOKEN_KEY).catch(() => null);
  }
}

/**
 * Registers for a token when permission is already granted. Never prompts -
 * that is `requestPermission()`. Safe to call repeatedly.
 */
export async function refreshPushToken(): Promise<PushTokenState> {
  const reason = unsupportedReason();
  if (reason) {
    warnUnsupported(reason);
    setState({ token: null, status: "unsupported" });
    return state;
  }
  try {
    const { granted } = await Notifications.getPermissionsAsync();
    if (!granted) {
      setState({ token: null, status: "denied" });
      return state;
    }
    const token = await fetchToken(getProjectId()!);
    setState(token ? { token, status: "granted" } : { token: null, status: "denied" });
  } catch (err) {
    console.warn("[push] permission check failed", err);
    setState({ token: null, status: "denied" });
  }
  return state;
}

/**
 * Prompts the OS permission dialog; resolves `true` when notifications are
 * allowed. That is the answer for *local* notifications too, so it stays `true`
 * on a simulator or without an EAS project - only the token state reports
 * `unsupported` there (remote push needs both).
 */
export async function requestPushPermission(): Promise<boolean> {
  const reason = unsupportedReason();
  if (reason === "web") {
    setState({ token: null, status: "unsupported" });
    return false;
  }
  try {
    const { granted } = await Notifications.requestPermissionsAsync();
    if (!granted) {
      setState({ token: null, status: "denied" });
      return false;
    }
    if (reason) {
      warnUnsupported(reason);
      setState({ token: null, status: "unsupported" });
      return true;
    }
    const token = await fetchToken(getProjectId()!);
    setState(token ? { token, status: "granted" } : { token: null, status: "denied" });
    return token !== null;
  } catch (err) {
    console.warn("[push] requestPermissionsAsync failed", err);
    setState({ token: null, status: "denied" });
    return false;
  }
}

/** Kicks off the first registration once per app session. */
export function ensurePushStarted() {
  if (started) return;
  started = true;
  void refreshPushToken();
}

/** Current token + status; subscribes to changes. Works without any provider. */
export function usePushToken(): PushTokenState {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => {
    ensurePushStarted();
  }, []);
  return snapshot;
}

/** Test-only: back to the initial state. */
export function __resetPushTokenForTests() {
  started = false;
  state = { token: null, status: "loading" };
  listeners.forEach((l) => l());
}
