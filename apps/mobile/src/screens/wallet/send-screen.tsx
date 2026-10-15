import { suggestedReference, type PayeeDto } from "@kassa/shared";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";

import { useFundingSources, useSendQuote } from "@/api/hooks/funding-sources";
import { usePayees } from "@/api/hooks/payees";
import { usePayPayee, useWallet } from "@/api/hooks/wallet";
import { errorText } from "@/components/kassa/error-text";
import { MoneyInput } from "@/components/kassa/money-input";
import { QueryView } from "@/components/kassa/query-view";
import { ScrollScreen } from "@/components/kassa/scroll-screen";
import { RowGroup } from "@/components/row-group";
import { Box, Button, Card, Icon, Input, Row, Text } from "@/components/ui";
import { copyToClipboard } from "@/lib/clipboard";
import { useFormat } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { useKassaT } from "@/lib/i18n";
import { rememberSend, useLastSend } from "@/stores/last-send";

import { DeliveredReceipt } from "./delivered-receipt";
import { sourceIcon } from "./linked-accounts-screen";

/** The user's own Kassa ID with a copy button: what someone else types to pay them. */
export function KassaIdCard() {
  const t = useKassaT();
  const wallet = useWallet();
  if (!wallet.data) return null;
  const id = wallet.data.kassaId;
  return (
    <Card>
      <Box gap={2}>
        <Text variant="caption">{t("wallet:kassaId")}</Text>
        <Box row justify="between" align="center">
          <Text
            variant="heading"
            selectable
            testID="kassa-id"
            style={{ fontVariant: ["tabular-nums"], letterSpacing: 1 }}
          >
            {id}
          </Text>
          <Button
            size="sm"
            variant="secondary"
            onPress={() => void copyToClipboard(id, { toast: t("wallet:kassaIdCopied") })}
          >
            {t("wallet:kassaIdCopy")}
          </Button>
        </Box>
        <Text variant="caption">{t("wallet:kassaIdHint")}</Text>
      </Box>
    </Card>
  );
}

/**
 * Verified payees, and cooling ones (payable with a passkey once the 24 hours are over; the server checks). Card
 * merchants are paid at the till or by QR, not by transfer.
 */
const payable = (p: PayeeDto) =>
  (p.status === "VERIFIED" || p.status === "COOLING") && !p.accountMissing && p.kind !== "MERCHANT";

type Sent = {
  amountMinor: number;
  currency: string;
  payeeName: string;
  deliveredInMs?: number;
  auto: boolean;
};

/** Where the money comes from: the Kassa wallet or one of the user's linked cards and bank accounts. */
function FromPicker({
  value,
  onChange,
  currency,
}: {
  value: string | null;
  onChange: (id: string | null) => void;
  currency: string;
}) {
  const t = useKassaT();
  const sources = useFundingSources();
  const active = (sources.data?.sources ?? []).filter((s) => s.status === "ACTIVE");
  const tick = (selected: boolean) =>
    selected ? <Icon name="checkmark" fallback="check" size={20} color="brandAccent" /> : undefined;
  return (
    <RowGroup title={t("wallet:from")} icons>
      <Row
        testID="send-from-wallet"
        leading={
          <Icon
            name="wallet.pass.fill"
            fallback="account_balance_wallet"
            size={20}
            color="brandAccent"
          />
        }
        title={t("wallet:fromWallet")}
        subtitle={t("wallet:fromWalletHint", { currency })}
        onPress={() => onChange(null)}
        trailing={tick(value === null)}
      />
      {active.map((s) => {
        const icon = sourceIcon(s);
        return (
          <Row
            key={s.id}
            testID={`send-from-${s.id}`}
            leading={
              <Icon name={icon.name} fallback={icon.fallback} size={20} color="brandAccent" />
            }
            title={s.label}
            subtitle={t("wallet:fromLinkedHint", {
              kind: t(`wallet:kind.${s.kind}`),
              currency: s.currency,
            })}
            onPress={() => onChange(s.id)}
            trailing={tick(value === s.id)}
          />
        );
      })}
      <Row
        leading={<Icon name="plus.circle" fallback="add_circle" size={20} color="foreground" />}
        title={t("wallet:linkAccount")}
        onPress={() => router.push("/linked-accounts")}
      />
    </RowGroup>
  );
}

/** The live quote: what the send debits (fees and FX included) and when it arrives. Signs nothing. */
function QuoteLine({
  payeeId,
  amountMinor,
  sourceId,
  fromLabel,
}: {
  payeeId: string;
  amountMinor: number | null;
  sourceId: string | null;
  fromLabel: string;
}) {
  const t = useKassaT();
  const f = useFormat();
  const quote = useSendQuote(payeeId, amountMinor, sourceId);
  if (!amountMinor) return null;
  if (quote.isPending) return <Text variant="caption">{t("wallet:quote.loading")}</Text>;
  const q = quote.data;
  if (!q) return null;
  if (q.status === "NONE") return <Text color="destructive">{t("wallet:quote.none")}</Text>;
  if (q.debitMinor === null || !q.fundingCurrency) {
    return <Text variant="caption">{t("wallet:quote.unknown")}</Text>;
  }
  return (
    <Card>
      <Box gap={1} testID="send-quote">
        <Text weight="semibold">
          {t("wallet:quote.line", {
            debit: f.money(q.debitMinor, q.fundingCurrency),
            from: fromLabel,
          })}
        </Text>
        {q.markupBps && q.maxDebitMinor !== null ? (
          <Text variant="caption">
            {t("wallet:quote.fx", {
              pct: q.markupBps / 100,
              max: f.money(q.maxDebitMinor, q.fundingCurrency),
            })}
          </Text>
        ) : null}
        <Text variant="caption">
          {q.instant
            ? t("wallet:quote.instant")
            : q.arrivalDate
              ? t("wallet:quote.arrives", { date: f.date(q.arrivalDate) })
              : ""}
        </Text>
      </Box>
    </Card>
  );
}

/**
 * Send money to a saved recipient, the way GME Remit does it: recipient, amount, where from, the quote, then one
 * approval. This only proposes the payment: the server checks it against the signed rules and the order sheet asks
 * for the passkey, unless it is inside a mandate the user signed (then it goes straight through).
 */
export function SendScreen() {
  const t = useKassaT();
  const params = useLocalSearchParams<{ payeeId?: string }>();
  const payees = usePayees();
  const sources = useFundingSources();
  const pay = usePayPayee();
  const last = useLastSend();
  const [payeeId, setPayeeId] = useState<string | null>(params.payeeId ?? null);
  const [amountMinor, setAmountMinor] = useState<number | null>(null);
  const [purpose, setPurpose] = useState("");
  const [fromId, setFromId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<Sent | null>(null);

  const labelOf = (id: string | null) =>
    id === null
      ? t("wallet:fromWallet")
      : (sources.data?.sources.find((s) => s.id === id)?.label ?? t("wallet:fromWallet"));

  const send = async (
    payee: PayeeDto,
    req: { amountMinor: number; purpose: string; fundingSourceId: string | null }
  ) => {
    setError(null);
    try {
      const res = await pay.mutateAsync({
        payeeId: payee.id,
        amountMinor: req.amountMinor,
        currency: payee.currency,
        purpose: req.purpose,
        ...(req.fundingSourceId ? { fundingSourceId: req.fundingSourceId } : {}),
      });
      rememberSend({ payeeId: payee.id, currency: payee.currency, ...req });
      haptics.success();
      // Inside a signed mandate (or the small-auto limit) it already went: show the receipt right here.
      if (res.decision === "AUTO" && res.paymentStatus && res.paymentStatus !== "FAILED") {
        setSent({
          amountMinor: req.amountMinor,
          currency: payee.currency,
          payeeName: payee.name,
          ...(res.deliveredInMs !== undefined ? { deliveredInMs: res.deliveredInMs } : {}),
          auto: true,
        });
        return;
      }
      router.push(`/order/${res.proposalId}`);
    } catch (err) {
      haptics.error();
      setError(errorText(t, err));
    }
  };

  const submit = (payee: PayeeDto | undefined) => {
    if (!payee) return setError(t("wallet:pickPayee"));
    if (!amountMinor) return setError(t("wallet:errors.AMOUNT"));
    // The recipient's own reference (student ID, customer number) unless the user wrote one.
    const p = purpose.trim() || suggestedReference(payee.details) || t("wallet:purposePlaceholder");
    return send(payee, { amountMinor, purpose: p, fundingSourceId: fromId });
  };

  if (sent) {
    return (
      <ScrollScreen testID="send-done">
        <DeliveredReceipt
          deliveredInMs={sent.deliveredInMs}
          amountMinor={sent.amountMinor}
          currency={sent.currency}
          payeeName={sent.payeeName}
          viaMandate={sent.auto}
        />
        <Button size="lg" onPress={() => setSent(null)}>
          {t("wallet:sendNow")}
        </Button>
        <Button
          variant="ghost"
          onPress={() => (router.canGoBack() ? router.back() : router.replace("/home"))}
        >
          {t("wallet:done")}
        </Button>
      </ScrollScreen>
    );
  }

  return (
    <ScrollScreen testID="send">
      <QueryView query={payees} skeletonRows={3}>
        {(data) => {
          const list = data.payees.filter(payable);
          const chosen = list.find((p) => p.id === payeeId);
          const again = last ? list.find((p) => p.id === last.payeeId) : undefined;
          return (
            <>
              {last && again && !payeeId ? (
                <Card>
                  <Box gap={2} testID="send-again">
                    <Text variant="label">{t("wallet:sendAgain")}</Text>
                    <SendAgainLine
                      amountMinor={last.amountMinor}
                      currency={last.currency}
                      name={again.name}
                      from={labelOf(last.fundingSourceId)}
                    />
                    <Button
                      onPress={() =>
                        void send(again, {
                          amountMinor: last.amountMinor,
                          purpose: last.purpose,
                          fundingSourceId: last.fundingSourceId,
                        })
                      }
                      loading={pay.isPending}
                    >
                      {t("wallet:sendAgain")}
                    </Button>
                  </Box>
                </Card>
              ) : null}
              {list.length === 0 ? (
                <Card>
                  <Text variant="caption">{t("wallet:noPayees")}</Text>
                </Card>
              ) : (
                <RowGroup title={t("wallet:to")}>
                  {list.map((p) => (
                    <Row
                      key={p.id}
                      testID={`send-payee-${p.id}`}
                      title={p.name}
                      subtitle={[
                        t(`payees:category.${p.category}`),
                        p.accountMasked,
                        ...(p.status === "COOLING" ? [t("wallet:cooling")] : []),
                      ].join(" · ")}
                      onPress={() => {
                        haptics.selection();
                        setPayeeId(p.id);
                      }}
                      trailing={
                        p.id === payeeId ? (
                          <Icon name="checkmark" fallback="check" size={20} color="brandAccent" />
                        ) : (
                          <Text variant="caption">{p.currency}</Text>
                        )
                      }
                    />
                  ))}
                </RowGroup>
              )}
              <Button variant="link" onPress={() => router.push("/payees")}>
                {t("wallet:addPayee")}
              </Button>

              {chosen ? (
                <Box gap={3}>
                  <Box gap={2}>
                    <Text variant="label">{t("wallet:amount")}</Text>
                    <MoneyInput
                      testID="send-amount"
                      valueMinor={amountMinor}
                      currency={chosen.currency}
                      onChange={setAmountMinor}
                      accessibilityLabel={t("wallet:amount")}
                    />
                  </Box>
                  <FromPicker value={fromId} onChange={setFromId} currency={chosen.currency} />
                  <QuoteLine
                    payeeId={chosen.id}
                    amountMinor={amountMinor}
                    sourceId={fromId}
                    fromLabel={labelOf(fromId)}
                  />
                  <Input
                    label={t("wallet:purpose")}
                    value={purpose}
                    onChangeText={setPurpose}
                    placeholder={
                      suggestedReference(chosen.details) || t("wallet:purposePlaceholder")
                    }
                  />
                </Box>
              ) : null}

              {error ? <Text color="destructive">{error}</Text> : null}
              <Box gap={1}>
                <Button size="lg" loading={pay.isPending} onPress={() => void submit(chosen)}>
                  {t("wallet:review")}
                </Button>
                <Text variant="caption" style={{ textAlign: "center" }}>
                  {t("wallet:reviewHint")}
                </Text>
              </Box>
            </>
          );
        }}
      </QueryView>
      <KassaIdCard />
    </ScrollScreen>
  );
}

function SendAgainLine(props: {
  amountMinor: number;
  currency: string;
  name: string;
  from: string;
}) {
  const t = useKassaT();
  const f = useFormat();
  return (
    <Text>
      {t("wallet:sendAgainLine", {
        amount: f.money(props.amountMinor, props.currency),
        name: props.name,
        from: props.from,
      })}
    </Text>
  );
}
