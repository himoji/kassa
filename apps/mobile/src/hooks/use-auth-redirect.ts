/**
 * Route guard (kit contract, see the original note in git history): signed-out users go to the
 * welcome screen, signed-in users leave the auth group, users who have not confirmed onboarding
 * (GET /me `onboarded: false`) go to the onboarding chat. Public routes: the auth group and the
 * credit-record verify page (spec §16 "public web route").
 * (Business M4) A BUSINESS account on a personal-only tab goes to its Today tab, and the other way round
 * (the tab layout hides the other set, so those routes cannot be shown).
 * A signed-out deep link (a till QR opens `/pay/<billId>`) is remembered and restored after sign-in
 * (src/lib/return-path.ts: same-app relative paths only).
 */
import { type Href, router, usePathname, useRootNavigationState, useSegments } from "expo-router";
import { useEffect } from "react";

import { useMe } from "@/api/hooks/me";
import { bootstrapSession } from "@/api/session";
import { clearReturnPathIfAt, peekReturnPath, rememberReturnPath } from "@/lib/return-path";
import { useSessionStore } from "@/stores/session";

const PUBLIC_ROOTS = new Set(["(auth)", "verify"]);
const PERSONAL_TABS = new Set(["home", "activity", "cards"]);
const BUSINESS_TABS = new Set(["today", "stock", "orders"]);

export function useAuthRedirect(): void {
  const status = useSessionStore((s) => s.status);
  const segments = useSegments();
  const pathname = usePathname();
  const ready = Boolean(useRootNavigationState()?.key);
  const { data: me } = useMe();
  // Known once /me loaded (an older API without the field = PERSONAL).
  const accountType = me ? (me.accountType ?? "PERSONAL") : undefined;

  useEffect(() => {
    void bootstrapSession();
  }, []);

  useEffect(() => {
    if (!ready || status === "loading") return;
    const root = segments[0] ?? "";
    if (status === "unauthenticated") {
      if (!PUBLIC_ROOTS.has(root)) {
        rememberReturnPath(pathname);
        router.replace("/welcome");
      }
      return;
    }
    clearReturnPathIfAt(pathname);
    if (root === "(auth)") {
      const returnPath = peekReturnPath();
      router.replace(
        me?.onboarded === false
          ? "/onboarding/chat"
          : returnPath
            ? (returnPath as Href)
            : accountType === "BUSINESS"
              ? "/today"
              : "/home"
      );
      return;
    }
    if (me?.onboarded === false && root !== "onboarding" && root !== "verify") {
      router.replace("/onboarding/chat");
      return;
    }
    const tab = (segments as string[])[1] ?? "";
    if (root === "(tabs)" && accountType) {
      if (accountType === "BUSINESS" && PERSONAL_TABS.has(tab)) router.replace("/today");
      else if (accountType !== "BUSINESS" && BUSINESS_TABS.has(tab)) router.replace("/home");
    }
  }, [ready, status, segments, pathname, me?.onboarded, accountType]);
}
