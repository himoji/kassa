import { Redirect, type Href } from "expo-router";

import { useSessionStore } from "@/stores/session";

/** "/" - an unpaired phone starts on Pair (the tabs are guarded, so /home would render nothing). */
export default function Index() {
  const status = useSessionStore((s) => s.status);
  if (status === "loading") return null;
  if (status !== "authenticated") return <Redirect href={"/pair" as Href} />;
  return <Redirect href={"/home" as Href} />;
}
