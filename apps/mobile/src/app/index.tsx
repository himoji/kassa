import { Redirect } from "expo-router";

import { useMe } from "@/api/hooks/me";
import { useSessionStore } from "@/stores/session";

/** "/" - the guard in the root layout decides; this only picks the first screen. */
export default function Index() {
  const status = useSessionStore((s) => s.status);
  const me = useMe();
  if (status === "loading" || me.isLoading) return null;
  if (status !== "authenticated") return <Redirect href="/welcome" />;
  // (Business M4) a BUSINESS account starts on its Today tab.
  return <Redirect href={me.data?.accountType === "BUSINESS" ? "/today" : "/home"} />;
}
