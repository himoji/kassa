import type { ImportItems, ImportPreviewResponse } from "@kassa/shared";

import { SettingSwitch } from "@/components/kassa/native-controls";
import { categoryLabel } from "@/components/kassa/spend-charts";
import { Box, Button, Card, Text } from "@/components/ui";
import { useFormat } from "@/lib/format";
import { useKassaT } from "@/lib/i18n";

/** Preview sections the user can switch off. Transfers to people are spending rows with category "transfers". */
export type PreviewSection =
  "transactions" | "transfers" | "bills" | "cards" | "budgets" | "incomes";
export const PREVIEW_SECTIONS: PreviewSection[] = [
  "transactions",
  "transfers",
  "incomes",
  "bills",
  "cards",
  "budgets",
];
export type SectionSwitches = Record<PreviewSection, boolean>;

export const ALL_ON: SectionSwitches = {
  transactions: true,
  transfers: true,
  bills: true,
  cards: true,
  budgets: true,
  incomes: true,
};

/** The preview's items with the switched-off sections removed (budgets are applied separately, with the passkey). */
export function selectedItems(result: ImportPreviewResponse, on: SectionSwitches): ImportItems {
  const tx = result.items.transactions.filter((t) =>
    t.category === "transfers" ? on.transfers : on.transactions
  );
  return {
    transactions: tx,
    bills: on.bills ? result.items.bills : [],
    cards: on.cards ? result.items.cards : [],
    budgets: on.budgets ? result.items.budgets : [],
    incomes: on.incomes ? result.items.incomes : [],
  };
}

function sectionCount(result: ImportPreviewResponse, s: PreviewSection): number {
  if (s === "transactions")
    return result.items.transactions.filter((t) => t.category !== "transfers").length;
  if (s === "transfers")
    return result.items.transactions.filter((t) => t.category === "transfers").length;
  return result.items[s].length;
}

/** "What Kassa learned": the history in plain lines (computed by the server, never by a model). */
export function HistorySummary({ result }: { result: ImportPreviewResponse }) {
  const t = useKassaT();
  const f = useFormat();
  const h = result.history;
  if (!h) return null;
  const home = h.homeCurrency;
  const top = h.spendingByCategory.filter((c) => c.category !== "transfers").slice(0, 4);
  return (
    <Box gap={1}>
      <Text weight="semibold">{t("settings:data.learned.title")}</Text>
      {h.from && h.to ? (
        <Text variant="caption">
          {t("settings:data.learned.period", {
            rows: h.counts.rows,
            from: f.date(h.from, "medium"),
            to: f.date(h.to, "medium"),
          })}
        </Text>
      ) : null}
      <Text variant="caption">
        {t("settings:data.learned.spending", {
          amount: f.money(h.monthlySpendingHomeMinor, home),
          top: top
            .map((c) => `${categoryLabel(t, c.category)} ${f.money(c.monthlyHomeMinor, home)}`)
            .join(", "),
        })}
      </Text>
      {h.incomes.slice(0, 3).map((i) => (
        <Text key={`${i.source}-${i.amount.currency}`} variant="caption">
          {t("settings:data.learned.income", {
            source: i.source,
            amount: f.money(i.amount.amountMinor, i.amount.currency),
          })}
        </Text>
      ))}
      {h.recurring.slice(0, 3).map((r) => (
        <Text key={r.name} variant="caption">
          {t("settings:data.learned.recurring", {
            name: r.name,
            amount: f.money(r.amount.amountMinor, r.amount.currency),
            next: f.date(r.nextDate, "medium"),
          })}
        </Text>
      ))}
      {h.fees.totalHomeMinor > 0 ? (
        <Text variant="caption">
          {h.fees.fxMarkupBps !== null
            ? t("settings:data.learned.feesFx", {
                amount: f.money(h.fees.totalHomeMinor, home),
                pct: f.bps(h.fees.fxMarkupBps),
              })
            : t("settings:data.learned.fees", { amount: f.money(h.fees.totalHomeMinor, home) })}
        </Text>
      ) : null}
      {h.counts.ownTransfers > 0 ? (
        <Text variant="caption" color="mutedForeground">
          {t("settings:data.learned.own", { count: h.counts.ownTransfers })}
        </Text>
      ) : null}
    </Box>
  );
}

/** Files as Kassa read them, the history, the sections to import, warnings, and the import button. */
export function ImportPreviewCard({
  result,
  on,
  setOn,
  onImport,
  busy,
  importLabel,
  sections = PREVIEW_SECTIONS,
}: {
  result: ImportPreviewResponse;
  on: SectionSwitches;
  setOn: (next: SectionSwitches) => void;
  onImport: () => void;
  busy: boolean;
  importLabel: string;
  sections?: PreviewSection[];
}) {
  const t = useKassaT();
  const f = useFormat();
  const shown = sections.filter((s) => sectionCount(result, s) > 0);
  return (
    <Card>
      <Box gap={3}>
        <Text weight="semibold">
          {result.source === "kassa" ? t("settings:data.fromKassa") : t("settings:data.fromOther")}
        </Text>
        {result.files.map((file) => (
          <Text key={file.name} variant="caption">
            {t("settings:data.file", {
              name: file.name,
              bank: file.bank ?? t(`settings:data.format.${file.format}`),
              rows: file.rows,
              via: t(`settings:data.via.${file.via}`),
            })}
            {file.cardLast4 ? ` · •••• ${file.cardLast4}` : ""}
          </Text>
        ))}
        {result.files.length === 0
          ? result.mappings.map((m) => (
              <Text key={`${m.path}-${m.kind}`} variant="caption">
                {t("settings:data.mapping", {
                  path: m.path,
                  kind: t(`settings:data.kind.${m.kind}`),
                  imported: m.imported,
                  rows: m.rows,
                  fields: Object.entries(m.fields)
                    .map(([to, from]) => `${from} → ${to}`)
                    .join(", "),
                })}
              </Text>
            ))
          : null}
        <HistorySummary result={result} />
        {shown.map((s) => (
          <SettingSwitch
            key={s}
            label={t(`settings:data.section.${s}`, { count: sectionCount(result, s) })}
            description={
              s === "budgets"
                ? t("settings:data.budgetsNote")
                : s === "bills"
                  ? t("settings:data.billsNote")
                  : undefined
            }
            value={on[s]}
            onChange={(v) => setOn({ ...on, [s]: v })}
          />
        ))}
        {[...result.items.transactions]
          .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
          .slice(0, 5)
          .map((x, i) => (
            <Box key={i} row justify="between" gap={2}>
              <Text variant="caption" numberOfLines={1} style={{ flexShrink: 1 }}>
                {f.date(x.occurredAt.slice(0, 10), "medium")} · {x.merchant}
              </Text>
              <Text variant="caption" style={{ fontVariant: ["tabular-nums"] }}>
                {f.money(x.amountMinor, x.currency)}
              </Text>
            </Box>
          ))}
        {result.warnings.map((w) => (
          <Text key={w} variant="caption" color="mutedForeground">
            {w}
          </Text>
        ))}
        <Button size="lg" loading={busy} disabled={!shown.some((s) => on[s])} onPress={onImport}>
          {importLabel}
        </Button>
      </Box>
    </Card>
  );
}
