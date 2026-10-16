/**
 * Attack evidence (public, no sign-in): the famous agent money hacks recreated against Kassa and against a naive agent
 * with the same intent and no guards. The data is docs/evidence/attacks.json, written by the test suite
 * (`bun run evidence:attacks`), bundled as it is: this page only shows it.
 */
import { router } from "expo-router";

import { ScrollScreen } from "@/components/kassa/scroll-screen";
import { StatusChip } from "@/components/kassa/status-chip";
import { Box, Button, Card, Text } from "@/components/ui";
import { useFormat } from "@/lib/format";
import { useKassaT } from "@/lib/i18n";

import evidence from "../../../../../docs/evidence/attacks.json";

type Case = { case: string; outcome: string; decision: string | null; reasonCodes: string[] };
type Attack = {
  attack: string;
  expected: string;
  guarded: { paid: boolean; cases: Case[] };
  naive: { outcome: string; paid: boolean; detail: string } | null;
};
type EvidenceFile = {
  note: string;
  summary: { total: number; guardedPaid: number; naivePaid: number };
  attacks: Record<string, Attack>;
};

const data = evidence as unknown as EvidenceFile;

/** The attacks in id order (A1 … A17). */
export function attackList(file: EvidenceFile = data): (Attack & { id: string })[] {
  return Object.entries(file.attacks)
    .map(([id, a]) => ({ id, ...a }))
    .sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
}

/** "… received 45000000 HUF (minor units) via …" → the amount as money. */
export function moneyInDetail(
  detail: string,
  money: (minor: number, currency: string) => string
): string {
  return detail.replace(/(\d+) ([A-Z]{3}) \(minor units\)/g, (_m, n: string, ccy: string) =>
    money(Number(n), ccy)
  );
}

export function EvidenceScreen() {
  const t = useKassaT();
  const f = useFormat();
  const { summary } = data;
  return (
    <ScrollScreen>
      <Text variant="caption">{t("evidence:intro")}</Text>
      <Box row gap={3}>
        <Card style={{ flex: 1 }}>
          <Box gap={1}>
            <Text variant="title">
              {t("evidence:ofTotal", { paid: summary.guardedPaid, total: summary.total })}
            </Text>
            <Text variant="caption">{t("evidence:guarded")}</Text>
          </Box>
        </Card>
        <Card style={{ flex: 1 }}>
          <Box gap={1}>
            <Text variant="title" color="mutedForeground">
              {t("evidence:ofTotal", { paid: summary.naivePaid, total: summary.total })}
            </Text>
            <Text variant="caption">{t("evidence:naive")}</Text>
          </Box>
        </Card>
      </Box>
      {attackList().map((a) => (
        <Card key={a.id}>
          <Box gap={2}>
            <Box row justify="between" align="center" gap={2}>
              <Text weight="semibold" style={{ flex: 1 }}>
                {a.id} · {a.attack}
              </Text>
              <StatusChip
                tone={a.guarded.paid ? "critical" : "positive"}
                label={a.guarded.paid ? t("evidence:paid") : t("evidence:blocked")}
              />
            </Box>
            {a.naive ? (
              <Text variant="caption" color="mutedForeground">
                {t("evidence:naiveLine", { detail: moneyInDetail(a.naive.detail, f.money) })}
              </Text>
            ) : null}
            {a.guarded.cases.map((c) => (
              <Text key={c.case} variant="caption">
                • {c.case}
                {c.reasonCodes.length > 0
                  ? ` → ${c.reasonCodes.map((code) => t(`reasonCodes:${code}.label`, { defaultValue: t(`evidence:codes.${code}`, { defaultValue: code }) })).join(", ")}`
                  : ""}
              </Text>
            ))}
          </Box>
        </Card>
      ))}
      <Text variant="caption" color="mutedForeground">
        {t("evidence:how")}
      </Text>
      <Button variant="outline" onPress={() => router.back()}>
        {t("evidence:back")}
      </Button>
    </ScrollScreen>
  );
}
