import { CardKind, type CardDto } from "@kassa/shared";
import { useState } from "react";

import { useMe } from "@/api/hooks/me";
import { useCardFees, useCards, useCreateCard, useDeleteCard } from "@/api/hooks/money";
import { RowGroup } from "@/components/row-group";
import { SimulatedBadge } from "@/components/kassa/badges";
import { errorText } from "@/components/kassa/error-text";
import { SettingPicker } from "@/components/kassa/native-controls";
import { QueryView } from "@/components/kassa/query-view";
import { ScrollScreen } from "@/components/kassa/scroll-screen";
import { StatusChip } from "@/components/kassa/status-chip";
import { Box, Button, Card, Divider, Icon, Input, Sheet, Text, toast } from "@/components/ui";
import { currencyCodes, useFormat } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { useKassaT } from "@/lib/i18n";

/** A sensible kind for a card's billing currency (the user can change it). */
export function suggestedKind(currency: string, homeCurrency: string | undefined): CardKind {
  if (currency === homeCurrency) return "HOME_KZT";
  if (currency === "USD") return "USD";
  return "LOCAL_HUF";
}

/** Add a card by hand: a name, the last 4 digits and the billing currency; never the full number. */
function AddCardSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const t = useKassaT();
  const f = useFormat();
  const me = useMe();
  const create = useCreateCard();
  const home = me.data?.settings.homeCurrency;
  const [label, setLabel] = useState("");
  const [last4, setLast4] = useState("");
  const [currency, setCurrency] = useState<string>(home ?? "EUR");
  const [kind, setKind] = useState<CardKind>(suggestedKind(home ?? "EUR", home));
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    if (!label.trim() || !/^\d{4}$/.test(last4)) {
      setError(t("cards:add.invalid"));
      return;
    }
    try {
      await create.mutateAsync({ label: label.trim(), last4, billingCurrency: currency, kind });
      haptics.success();
      toast.show({ title: t("cards:add.added") });
      setLabel("");
      setLast4("");
      onClose();
    } catch (err) {
      haptics.error();
      setError(errorText(t, err));
    }
  };

  return (
    <Sheet visible={visible} onClose={onClose} detents={["full"]}>
      <Box p={5} gap={4}>
        <Text variant="heading">{t("cards:add.title")}</Text>
        <Text variant="caption">{t("cards:add.why")}</Text>
        <Input
          label={t("cards:add.label")}
          placeholder={t("cards:add.labelPlaceholder")}
          value={label}
          onChangeText={setLabel}
          autoCapitalize="words"
        />
        <Input
          label={t("cards:add.last4")}
          placeholder="1234"
          value={last4}
          onChangeText={(v) => setLast4(v.replace(/\D/g, "").slice(-4))}
          keyboardType="number-pad"
        />
        <SettingPicker
          label={t("cards:add.currency")}
          value={currency}
          options={currencyCodes().map((c) => ({ value: c, label: `${c} · ${f.currencyName(c)}` }))}
          onChange={(c) => {
            setCurrency(c);
            setKind(suggestedKind(c, home));
          }}
        />
        <SettingPicker
          label={t("cards:add.kind")}
          value={kind}
          options={CardKind.options.map((k) => ({ value: k, label: t(`cards:kind.${k}`) }))}
          onChange={setKind}
        />
        {error ? <Text color="destructive">{error}</Text> : null}
        <Button size="lg" onPress={() => void submit()} loading={create.isPending}>
          {t("cards:add.submit")}
        </Button>
        <Button variant="ghost" onPress={onClose}>
          {t("common:cancel")}
        </Button>
      </Box>
    </Sheet>
  );
}

function RemoveCardButton({ card }: { card: CardDto }) {
  const t = useKassaT();
  const remove = useDeleteCard();
  const [confirm, setConfirm] = useState(false);
  if (!confirm) {
    return (
      <Button variant="ghost" size="sm" onPress={() => setConfirm(true)}>
        {t("cards:remove")}
      </Button>
    );
  }
  return (
    <Box row gap={2} align="center" style={{ flexWrap: "wrap" }}>
      <Text variant="caption">
        {card.last4
          ? t("cards:removeConfirm", { last4: card.last4 })
          : t("cards:removeConfirmNoDigits")}
      </Text>
      <Button
        variant="destructive"
        size="sm"
        loading={remove.isPending}
        onPress={() => remove.mutate(card.id, { onSuccess: () => haptics.success() })}
      >
        {t("cards:remove")}
      </Button>
      <Button variant="ghost" size="sm" onPress={() => setConfirm(false)}>
        {t("common:cancel")}
      </Button>
    </Box>
  );
}

/** Cards and fee x-ray (spec §12 fee x-ray, §16). */
export function CardsScreen() {
  const t = useKassaT();
  const f = useFormat();
  const cards = useCards();
  const fees = useCardFees();
  const [adding, setAdding] = useState(false);

  return (
    <>
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

        <Button variant="outline" onPress={() => setAdding(true)}>
          {t("cards:add.title")}
        </Button>

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
                            {t(card.last4 ? "cards:cardMeta" : "cards:cardMetaNoDigits", {
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
                      <RemoveCardButton card={card} />
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
      <AddCardSheet visible={adding} onClose={() => setAdding(false)} />
    </>
  );
}
