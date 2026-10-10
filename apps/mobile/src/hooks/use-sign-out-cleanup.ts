/**
 * Every sign-out wipes this device's copy of the user: local data (minus UI preferences and
 * the consent decision), the analytics identity (the opt-out survives) and the data module's
 * query cache - whether the user tapped "Sign out", deleted the account, the session expired
 * or another tab signed out. Called once from the root layout, inside the providers.
 */
import { useEffect, useRef } from "react";

import { auth } from "@/lib/auth";
import { crash } from "@/lib/crash";
import { wipeLocalData } from "@/lib/privacy";

export function useSignOutCleanup(): void {
  const { status } = auth.useSession();
  const previous = useRef(status);

  useEffect(() => {
    const was = previous.current;
    previous.current = status;
    if (was !== "authenticated" || status !== "unauthenticated") return;
    wipeLocalData().catch((err: unknown) => {
      crash.capture(err, { where: "useSignOutCleanup" });
    });
  }, [status]);
}
