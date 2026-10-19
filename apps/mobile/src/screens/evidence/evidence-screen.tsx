/**
 * Attack evidence (public, no sign-in): the famous agent money hacks recreated against Kassa, against a chatbot whose
 * payment tool needs one confirm tap (and nothing else), and against a naive agent with no checks at all. The data is
 * docs/evidence/attacks.json, written by the test suite (`bun run evidence:attacks`), bundled as it is: this page only
 * shows it. Each case is REFUSED (code stopped it), ASKED (a passkey prompt on the exact order: a fooled user could
 * still approve it) or PAID.
 */
import { router } from "expo-router";

import { ScrollScreen } from "@/components/kassa/scroll-screen";
import { StatusChip } from "@/components/kassa/status-chip";
import { Box, Button, Card, Text } from "@/components/ui";
import { useFormat } from "@/lib/format";
import { useKassaT } from "@/lib/i18n";
import type { StatusTone } from "@/theme/status";

import evidence from "../../../../../docs/evidence/attacks.json";

export type Outcome = "REFUSED" | "ASKED" | "PAID";
type Case = {
  case: string;
  outcome: Outcome;
  decision?: string | null;
  reasonCodes: string[];
  payeeCooling: "IN_COOLING" | "COOLED_UNVERIFIED" | null;
  ifApproved?: { paysAttacker: boolean; note: string };
  note?: string;
};
type Attack = {
  attack: string;
  expected: string;
  guarded: { paid: boolean; worst: Outcome; paysAttackerIfUserApproves: boolean; cases: Case[] };
  tapConfirm: {
    paid: boolean;
    toAttacker: boolean;
    paidOnlyBecauseUserTapped: boolean;
    detail: string;
    note: string;
  } | null;
  naive: { outcome: string; paid: boolean; detail: string } | null;
};
type Summary = {
  total: number;
  guardedRefused: number;
  guardedAsked: number;
  guardedPaid: number;
  cases: { total: number; refused: number; asked: number; paid: number };
  guardedPaysAttackerIfUserApproves: number;
  tapConfirmPaid: number;
  tapConfirmPaidToAttacker: number;
  tapConfirmPaidOnlyBecauseUserTapped: number;
  tapConfirmCarefulUserPaid: number;
  naivePaid: number;
};
type EvidenceFile = { note: string; summary: Summary; attacks: Record<string, Attack> };

const data = evidence as unknown as EvidenceFile;

const TONE: Record<Outcome, StatusTone> = {
  REFUSED: "positive",
  ASKED: "warning",
  PAID: "critical",
};
const OUTCOME_KEY = { REFUSED: "refused", ASKED: "asked", PAID: "paid" } as const;

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
  const of = (paid: number) => t("evidence:ofTotal", { paid, total: summary.total });
  return (
    <ScrollScreen>
      <Text variant="caption">{t("evidence:intro")}</Text>
      <Card>
        <Box gap={1}>
          <Text variant="title">
            {t("evidence:kassaHeadline", {
              refused: summary.guardedRefused,
              asked: summary.guardedAsked,
              paid: summary.guardedPaid,
            })}
          </Text>
          <Text variant="caption">{t("evidence:kassaCaption", { total: summary.total })}</Text>
        </Box>
      </Card>
      <Card>
        <Box gap={2}>
          <Text weight="semibold">{t("evidence:fooledTitle")}</Text>
          <Box row gap={3}>
            <Box gap={1} style={{ flex: 1 }}>
              <Text variant="heading">{of(summary.guardedPaysAttackerIfUserApproves)}</Text>
              <Text variant="caption">{t("evidence:fooledKassa")}</Text>
            </Box>
            <Box gap={1} style={{ flex: 1 }}>
              <Text variant="heading" color="mutedForeground">
                {of(summary.tapConfirmPaidToAttacker)}
              </Text>
              <Text variant="caption">
                {t("evidence:fooledTap", { paid: summary.tapConfirmPaid })}
              </Text>
            </Box>
            <Box gap={1} style={{ flex: 1 }}>
              <Text variant="heading" color="mutedForeground">
                {of(summary.naivePaid)}
              </Text>
              <Text variant="caption">{t("evidence:fooledNaive")}</Text>
            </Box>
          </Box>
          <Text variant="caption" color="mutedForeground">
            {t("evidence:carefulLine", {
              kassa: summary.guardedPaid,
              tap: summary.tapConfirmCarefulUserPaid,
              total: summary.total,
            })}
          </Text>
        </Box>
      </Card>
      {attackList().map((a) => (
        <Card key={a.id}>
          <Box gap={2}>
            <Box row justify="between" align="center" gap={2}>
              <Text weight="semibold" style={{ flex: 1 }}>
                {a.id} · {a.attack}
              </Text>
              <StatusChip
                tone={TONE[a.guarded.worst]}
                label={t(`evidence:outcome.${OUTCOME_KEY[a.guarded.worst]}`)}
              />
            </Box>
            {a.guarded.cases.map((c) => (
              <Box key={c.case} gap={1}>
                <Text variant="caption">
                  • {t(`evidence:outcome.${OUTCOME_KEY[c.outcome]}`)}: {c.case}
                  {c.reasonCodes.length > 0
                    ? ` → ${c.reasonCodes.map((code) => t(`reasonCodes:${code}.label`, { defaultValue: t(`evidence:codes.${code}`, { defaultValue: code }) })).join(", ")}`
                    : ""}
                </Text>
                {c.payeeCooling ? (
                  <Text variant="caption" color="mutedForeground" style={{ paddingLeft: 12 }}>
                    {t(`evidence:cooling.${c.payeeCooling}`)}
                  </Text>
                ) : null}
                {c.outcome === "ASKED" && c.ifApproved ? (
                  <Text variant="caption" color="mutedForeground" style={{ paddingLeft: 12 }}>
                    {t("evidence:ifApproved", { note: c.ifApproved.note })}
                  </Text>
                ) : null}
                {c.note ? (
                  <Text variant="caption" color="mutedForeground" style={{ paddingLeft: 12 }}>
                    {c.note}
                  </Text>
                ) : null}
              </Box>
            ))}
            {a.tapConfirm ? (
              <Text variant="caption" color="mutedForeground">
                {t("evidence:tapLine", {
                  detail: moneyInDetail(a.tapConfirm.detail, f.money),
                  note: a.tapConfirm.note,
                })}
              </Text>
            ) : null}
            {a.naive ? (
              <Text variant="caption" color="mutedForeground">
                {t("evidence:naiveLine", { detail: moneyInDetail(a.naive.detail, f.money) })}
              </Text>
            ) : null}
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
