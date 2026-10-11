import { useCardFees, useCards } from "@/api/hooks/money";
import { RowGroup } from "@/components/row-group";
import { SimulatedBadge } from "@/components/kassa/badges";
import { QueryView } from "@/components/kassa/query-view";
import { ScrollScreen } from "@/components/kassa/scroll-screen";
import { StatusChip } from "@/components/kassa/status-chip";
import { Box, Card, Divider, Icon, Text } from "@/components/ui";
import { useFormat } from "@/lib/format";
import { useKassaT } from "@/lib/i18n";

/** Cards and fee x-ray (spec §12 fee x-ray, §16). */
export function CardsScreen() {
  const t = useKassaT();
  const f = useFormat();
  const cards = useCards();
  const fees = useCardFees();

  return (
    <ScrollScreen
      onRefresh={() => {
        void cards.refetch();
        void fees.refetch();
      }}
      refreshing={cards.isRefetching || fees.isRefetching}
    >
      <QueryView query={fees} skeletonRows={1}>
        {(x) => (
          <Card>
            <Box gap={2}>
              <Box row justify="between" align="center">
                <Text variant="caption">{t("cards:feesLostLabel")}</Text>
                {x.exampleValues ? <SimulatedBadge /> : null}
              </Box>
              <Text variant="title" style={{ fontVariant: ["tabular-nums"] }}>
                {f.money(x.monthlyFeesLostHomeMinor, x.homeCurrency)}
              </Text>
              <Text variant="caption">{t("cards:feesLostHint")}</Text>
              {x.exampleValues ? <Text variant="caption">{t("cards:exampleValues")}</Text> : null}
            </Box>
          </Card>
        )}
      </QueryView>

      <QueryView
        query={cards}
        isEmpty={(c) => c.cards.length === 0}
        empty={<Text variant="caption">{t("cards:noCards")}</Text>}
      >
        {(c) => (
          <Box gap={4}>
            {c.cards.map((card) => {
              const profiles = fees.data?.profiles.filter((p) => p.cardId === card.id) ?? [];
              const bestFor =
                fees.data?.bestCardByCurrency.filter((b) => b.cardId === card.id) ?? [];
              return (
                <Card key={card.id}>
                  <Box gap={3}>
                    <Box row gap={3} align="center">
                      <Icon name="creditcard.fill" fallback="credit_card" size={24} />
                      <Box flex={1}>
                        <Text weight="semibold">{card.label}</Text>
                        <Text variant="caption">
                          {t("cards:cardMeta", {
                            last4: card.last4,
                            currency: card.billingCurrency,
                            kind: t(`cards:kind.${card.kind}`),
                          })}
                        </Text>
                      </Box>
                    </Box>
                    {bestFor.length > 0 ? (
                      <Box row gap={2} style={{ flexWrap: "wrap" }}>
                        {bestFor.map((b) => (
                          <StatusChip
                            key={b.currency}
                            tone="positive"
                            label={t("cards:useFor", { currency: b.currency })}
                            icon={{ sf: "hand.thumbsup.fill", md: "thumb_up" }}
                          />
                        ))}
                      </Box>
                    ) : null}
                    {profiles.length > 0 ? (
                      <Box gap={2}>
                        <Divider spacing={0} />
                        {profiles.map((p) => (
                          <Box
                            key={`${p.fromCurrency}-${p.toCurrency}`}
                            row
                            justify="between"
                            gap={3}
                          >
                            <Text variant="caption">
                              {t("cards:pair", { from: p.fromCurrency, to: p.toCurrency })}
                            </Text>
                            <Text style={{ fontVariant: ["tabular-nums"] }}>
                              {t("cards:markup", {
                                markup: f.bps(p.medianMarkupBps),
                                samples: p.samples,
                              })}
                            </Text>
                          </Box>
                        ))}
                      </Box>
                    ) : null}
                  </Box>
                </Card>
              );
            })}
          </Box>
        )}
      </QueryView>

      {fees.data && fees.data.dccWarnings.length > 0 ? (
        <RowGroup title={t("cards:dccTitle")} footer={t("cards:dccExplainer")}>
          {fees.data.dccWarnings.map((w) => (
            <Box key={w.transactionId} p={4} gap={1}>
              <StatusChip tone="warning" label={t("cards:dccChip")} />
              <Text weight="semibold">{w.merchantNorm}</Text>
              <Text variant="caption">{t("cards:dccOverMid", { pct: f.bps(w.overMidBps) })}</Text>
            </Box>
          ))}
        </RowGroup>
      ) : null}
    </ScrollScreen>
  );
}
