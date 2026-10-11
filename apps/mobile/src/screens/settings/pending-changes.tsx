import { usePendingRuleChanges } from "@/api/hooks/settings";
import { RowGroup } from "@/components/row-group";
import { Countdown } from "@/components/kassa/countdown";
import { StatusChip } from "@/components/kassa/status-chip";
import { Box, Text } from "@/components/ui";
import { useFormat } from "@/lib/format";
import { useKassaT } from "@/lib/i18n";

/** Loosening changes waiting for their 24 h delay (I8), with a live countdown on the demo clock. */
export function PendingChanges() {
  const t = useKassaT();
  const f = useFormat();
  const { data } = usePendingRuleChanges();
  const changes = data?.changes.filter((c) => c.appliedAt === null) ?? [];
  if (changes.length === 0) return null;
  return (
    <RowGroup title={t("settings:pendingTitle")} footer={t("settings:pendingFooter")}>
      {changes.map((c) => (
        <Box key={c.id} p={4} gap={1}>
          <Box row justify="between" align="center" gap={2}>
            <Text weight="semibold" style={{ flexShrink: 1 }}>
              {t(`settings:ruleKind.${c.kind}`, { defaultValue: t("settings:ruleKind.OTHER") })}
            </Text>
            <StatusChip
              tone={c.direction === "LOOSEN" ? "warning" : "positive"}
              label={t(`settings:direction.${c.direction}`)}
            />
          </Box>
          <Countdown until={c.effectiveAt} prefixKey="settings:effectiveIn" />
          <Text variant="caption">
            {t("settings:effectiveAt", { time: f.dateTime(c.effectiveAt) })}
          </Text>
        </Box>
      ))}
    </RowGroup>
  );
}
