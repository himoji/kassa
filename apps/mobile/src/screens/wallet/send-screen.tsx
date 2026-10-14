import type { PayeeDto } from "@kassa/shared";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";

import { usePayees } from "@/api/hooks/payees";
import { usePayPayee, useWallet } from "@/api/hooks/wallet";
import { errorText } from "@/components/kassa/error-text";
import { MoneyInput } from "@/components/kassa/money-input";
import { QueryView } from "@/components/kassa/query-view";
import { ScrollScreen } from "@/components/kassa/scroll-screen";
import { RowGroup } from "@/components/row-group";
import { Box, Button, Card, Icon, Input, Row, Text } from "@/components/ui";
import { copyToClipboard } from "@/lib/clipboard";
import { haptics } from "@/lib/haptics";
import { useKassaT } from "@/lib/i18n";

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

/**
 * Send money to a saved payee (another Kassa user, an IBAN, Alipay, ACH...). This only proposes the payment: the
 * server checks it against the signed rules and the order sheet asks for the passkey, exactly like an agent's order.
 */
export function SendScreen() {
  const t = useKassaT();
  const params = useLocalSearchParams<{ payeeId?: string }>();
  const payees = usePayees();
  const pay = usePayPayee();
  const [payeeId, setPayeeId] = useState<string | null>(params.payeeId ?? null);
  const [amountMinor, setAmountMinor] = useState<number | null>(null);
  const [purpose, setPurpose] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = async (payee: PayeeDto | undefined) => {
    setError(null);
    if (!payee) return setError(t("wallet:pickPayee"));
    if (!amountMinor) return setError(t("wallet:errors.AMOUNT"));
    try {
      const res = await pay.mutateAsync({
        payeeId: payee.id,
        amountMinor,
        currency: payee.currency,
        purpose: purpose.trim() || t("wallet:purposePlaceholder"),
      });
      haptics.success();
      router.push(`/order/${res.proposalId}`);
    } catch (err) {
      haptics.error();
      setError(errorText(t, err));
    }
  };

  return (
    <ScrollScreen testID="send">
      <KassaIdCard />
      <QueryView query={payees} skeletonRows={3}>
        {(data) => {
          const list = data.payees.filter(payable);
          const chosen = list.find((p) => p.id === payeeId);
          return (
            <>
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
                      subtitle={
                        p.status === "COOLING"
                          ? `${p.accountMasked} · ${t("wallet:cooling")}`
                          : p.accountMasked
                      }
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
                  <Input
                    label={t("wallet:purpose")}
                    value={purpose}
                    onChangeText={setPurpose}
                    placeholder={t("wallet:purposePlaceholder")}
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
    </ScrollScreen>
  );
}
