/**
 * Register this install's Expo push token with the API (POST /devices) once per token, so
 * budget and approval notifications reach the phone (spec §13 delivery: push on native builds).
 */
import { RegisterDeviceRequest } from "@kassa/shared";
import { useEffect, useRef } from "react";
import { Platform } from "react-native";

import { api } from "@/api/client";
import { push } from "@/lib/push";
import { useSessionStore } from "@/stores/session";

export function useRegisterDevice(): void {
  const { token } = push.usePushToken();
  const status = useSessionStore((s) => s.status);
  const sent = useRef<string | null>(null);

  useEffect(() => {
    if (status !== "authenticated" || !token || sent.current === token) return;
    const body = RegisterDeviceRequest.parse({
      kind: "APP",
      expoPushToken: token,
      platform: Platform.OS === "ios" ? "ios" : Platform.OS === "android" ? "android" : "web",
    });
    sent.current = token;
    api.request("/devices", { json: body }).catch((err: unknown) => {
      sent.current = null;
      if (__DEV__) console.warn("[push] device registration failed", err);
    });
  }, [status, token]);
}
