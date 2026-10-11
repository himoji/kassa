import { Redirect } from "expo-router";

import { useSessionStore } from "@/stores/session";

/** "/" - the guard in the root layout decides; this only picks the first screen. */
export default function Index() {
  const status = useSessionStore((s) => s.status);
  if (status === "loading") return null;
  return <Redirect href={status === "authenticated" ? "/home" : "/welcome"} />;
}
