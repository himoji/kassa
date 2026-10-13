/**
 * Face ID lock. The app starts locked, authenticates on mount and again whenever it returns from the
 * background (`inactive` is ignored: the Face ID sheet itself makes the app inactive).
 * A device without any passcode / biometrics has nothing to unlock with, so it stays open.
 */
import * as LocalAuthentication from "expo-local-authentication";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";

import { i18next } from "@/lib/i18n";

export async function authenticate(): Promise<boolean> {
  try {
    const level = await LocalAuthentication.getEnrolledLevelAsync();
    if (level === LocalAuthentication.SecurityLevel.NONE) return true;
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: i18next.t("lite:lock.reason"),
    });
    return result.success;
  } catch {
    return false;
  }
}

export function useAppLock(): { locked: boolean; unlock: () => Promise<void> } {
  const [locked, setLocked] = useState(true);
  const busy = useRef(false);
  const lockedRef = useRef(true);

  const setLock = useCallback((value: boolean) => {
    lockedRef.current = value;
    setLocked(value);
  }, []);

  const unlock = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      if (await authenticate()) setLock(false);
    } finally {
      busy.current = false;
    }
  }, [setLock]);

  useEffect(() => {
    void unlock();
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "background") setLock(true);
      else if (state === "active" && lockedRef.current) void unlock();
    });
    return () => sub.remove();
  }, [unlock, setLock]);

  return { locked, unlock };
}
