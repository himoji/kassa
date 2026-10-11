/**
 * Route guard (kit contract, see the original note in git history): signed-out users go to the
 * welcome screen, signed-in users leave the auth group, users who have not confirmed onboarding
 * (GET /me `onboarded: false`) go to the onboarding chat. Public routes: the auth group and the
 * credit-record verify page (spec §16 "public web route").
 */
import { router, useRootNavigationState, useSegments } from "expo-router";
import { useEffect } from "react";

import { useMe } from "@/api/hooks/me";
import { bootstrapSession } from "@/api/session";
import { useSessionStore } from "@/stores/session";

const PUBLIC_ROOTS = new Set(["(auth)", "verify"]);

export function useAuthRedirect(): void {
  const status = useSessionStore((s) => s.status);
  const segments = useSegments();
  const ready = Boolean(useRootNavigationState()?.key);
  const { data: me } = useMe();

  useEffect(() => {
    void bootstrapSession();
  }, []);

  useEffect(() => {
    if (!ready || status === "loading") return;
    const root = segments[0] ?? "";
    if (status === "unauthenticated") {
      if (!PUBLIC_ROOTS.has(root)) router.replace("/welcome");
      return;
    }
    if (root === "(auth)") {
      router.replace(me?.onboarded === false ? "/onboarding/chat" : "/home");
      return;
    }
    if (me?.onboarded === false && root !== "onboarding" && root !== "verify") {
      router.replace("/onboarding/chat");
    }
  }, [ready, status, segments, me?.onboarded]);
}
