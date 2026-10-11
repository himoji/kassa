import { useMe } from "@/api/hooks/me";
import { useKassaT } from "@/lib/i18n";

import { StatusChip } from "./status-chip";

/** "Simulated" label on mock data (spec §0: everything mocked is labelled). */
export function SimulatedBadge() {
  const t = useKassaT();
  return (
    <StatusChip
      tone="neutral"
      label={t("common:simulated")}
      icon={{ sf: "testtube.2", md: "science" }}
    />
  );
}

/** "Replay" badge while the agent serves recordings (spec §9 replay mode). */
export function ReplayBadge({ force }: { force?: boolean }) {
  const t = useKassaT();
  const { data } = useMe();
  if (!force && data?.demo?.agentMode !== "REPLAY") return null;
  return (
    <StatusChip
      tone="info"
      label={t("chat:replay")}
      icon={{ sf: "play.rectangle.on.rectangle", md: "replay" }}
      testID="replay-badge"
    />
  );
}
