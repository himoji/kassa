import {
  SupportedCurrency,
  TestCard,
  type FundingSourceDto,
  type StartLinkResponse,
} from "@kassa/shared";
import { useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Linking, Pressable, View } from "react-native";

import {
  useConfirmLink,
  useFundingSources,
  useRemoveFundingSource,
  useStartLink,
} from "@/api/hooks/funding-sources";
import { useWallet } from "@/api/hooks/wallet";
import { SimulatedBadge } from "@/components/kassa/badges";
import { errorText } from "@/components/kassa/error-text";
import { SettingPicker } from "@/components/kassa/native-controls";
import { QueryView } from "@/components/kassa/query-view";
import { ScrollScreen } from "@/components/kassa/scroll-screen";
import { RowGroup } from "@/components/row-group";
import { Box, Button, Card, Icon, Input, Row, Sheet, Text, toast, useTheme } from "@/components/ui";
import { confirm } from "@/lib/confirm";
import { currencyCodes, useFormat } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { PasskeyCancelledError } from "@/lib/passkey-errors";
import { useKassaT } from "@/lib/i18n";
import { LITE_RETURN_URL, openWebAppStep } from "@/lite/approve";

import { ChipRow } from "../payees/recipient-fields";

/** Any currency the wallet holds, the demo's own first. */
const CURRENCIES: readonly string[] = currencyCodes().filter((c) =>
  (SupportedCurrency.options as readonly string[]).includes(c)
);
type Currency = string;
const BANKS = ["Kaspi Gold", "Halyk Bank", "Freedom Bank", "Jusan Bank", "OTHER"] as const;

export const sourceIcon = (s: Pick<FundingSourceDto, "kind">) =>
  s.kind === "CARD"
    ? { name: "creditcard.fill", fallback: "credit_card" }
    : { name: "building.columns.fill", fallback: "account_balance" };

function useHomeCurrency(): Currency {
  const home = useWallet().data?.homeCurrency;
  return home && CURRENCIES.includes(home) ? home : "KZT";
}

/** "Choose a test card" (Stripe's test PaymentMethods; production would show Stripe's card form). */
function LinkCardForm({ onDone }: { onDone: () => void }) {
  const t = useKassaT();
  const { colors } = useTheme();
  const start = useStartLink();
  const confirmLink = useConfirmLink();
  const [card, setCard] = useState<TestCard>("VISA");
  const [currency, setCurrency] = useState<Currency>(useHomeCurrency());
  const f = useFormat();
  const currencyOptions = CURRENCIES.map((c) => ({
    value: c,
    label: `${c} · ${f.currencyName(c)}`,
  }));
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    try {
      const started = await start.mutateAsync({ kind: "card", body: { testCard: card, currency } });
      const linked = await confirmLink.mutateAsync({ id: started.source.id });
      haptics.success();
      toast.show({
        title: t("wallet:linked.linkedToast", { label: linked.label }),
        kind: "success",
      });
      onDone();
    } catch (err) {
      if (err instanceof PasskeyCancelledError) return haptics.warning();
      haptics.error();
      setError(errorText(t, err));
    }
  };

  return (
    <Box p={5} gap={4}>
      <Box gap={1}>
        <Box row justify="between" align="center">
          <Text variant="heading">{t("wallet:linked.card.title")}</Text>
          <SimulatedBadge />
        </Box>
        <Text variant="caption">{t("wallet:linked.card.body")}</Text>
      </Box>
      <Box gap={2}>
        {TestCard.options.map((c) => (
          <Pressable
            key={c}
            onPress={() => setCard(c)}
            accessibilityRole="radio"
            accessibilityState={{ selected: c === card }}
            testID={`link-card-${c}`}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 12,
              padding: 14,
              borderRadius: 12,
              borderWidth: 1,
              borderColor: c === card ? colors.brandAccent : colors.border,
              backgroundColor: colors.card,
            }}
          >
            <Icon name="creditcard.fill" fallback="credit_card" size={22} color="brandAccent" />
            <Text style={{ flex: 1 }}>{t(`wallet:linked.card.${c}`)}</Text>
            {c === card ? (
              <Icon name="checkmark" fallback="check" size={18} color="brandAccent" />
            ) : null}
          </Pressable>
        ))}
      </Box>
      <SettingPicker
        label={t("wallet:linked.card.currency")}
        value={currency}
        options={currencyOptions}
        onChange={setCurrency}
        testID="link-card-currency"
      />
      {error ? <Text color="destructive">{error}</Text> : null}
      <Button
        size="lg"
        onPress={() => void submit()}
        loading={start.isPending || confirmLink.isPending}
      >
        {t("wallet:linked.card.continue")}
      </Button>
      <Button variant="ghost" onPress={onDone}>
        {t("common:cancel")}
      </Button>
    </Box>
  );
}

/** IBAN country, else Kazakhstan (local account numbers). */
const countryOf = (account: string) => {
  const head = account.replace(/\s+/g, "").slice(0, 2).toUpperCase();
  return /^[A-Z]{2}$/.test(head) ? head : "KZ";
};

/** Any bank: name, IBAN or account number, then the code from the tiny test payment, then the passkey. */
function LinkBankForm({ onDone, resume }: { onDone: () => void; resume: FundingSourceDto | null }) {
  const t = useKassaT();
  const start = useStartLink();
  const confirmLink = useConfirmLink();
  const [bank, setBank] = useState<(typeof BANKS)[number]>("Kaspi Gold");
  const [otherName, setOtherName] = useState("");
  const [account, setAccount] = useState("");
  const [currency, setCurrency] = useState<Currency>(useHomeCurrency());
  const f = useFormat();
  const currencyOptions = CURRENCIES.map((c) => ({
    value: c,
    label: `${c} · ${f.currencyName(c)}`,
  }));
  const [pending, setPending] = useState<{
    source: FundingSourceDto;
    simulatedCode?: string | undefined;
  } | null>(resume ? { source: resume } : null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  const begin = async () => {
    setError(null);
    const bankName = bank === "OTHER" ? otherName.trim() : bank;
    if (bankName.length < 2 || account.replace(/\s+/g, "").length < 6) {
      return setError(t("payees:add.errors.DETAILS_MISSING"));
    }
    try {
      const res: StartLinkResponse = await start.mutateAsync({
        kind: "bank",
        body: { bankName, account: account.trim(), country: countryOf(account), currency },
      });
      setPending({ source: res.source, simulatedCode: res.verification.simulatedCode });
      // Mock bank only: there is no statement to read, so the code is filled in (and labelled simulated).
      setCode(res.verification.simulatedCode ?? "");
    } catch (err) {
      haptics.error();
      setError(errorText(t, err));
    }
  };

  const finish = async () => {
    if (!pending) return;
    setError(null);
    try {
      const linked = await confirmLink.mutateAsync({ id: pending.source.id, code: code.trim() });
      haptics.success();
      toast.show({
        title: t("wallet:linked.linkedToast", { label: linked.label }),
        kind: "success",
      });
      onDone();
    } catch (err) {
      if (err instanceof PasskeyCancelledError) return haptics.warning();
      haptics.error();
      setError(errorText(t, err));
    }
  };

  if (pending) {
    return (
      <Box p={5} gap={4}>
        <Box gap={1}>
          <Text variant="heading">{t("wallet:linked.bank.codeTitle")}</Text>
          <Text variant="caption">
            {t("wallet:linked.bank.codeBody", {
              bank: pending.source.institution,
              last4: pending.source.last4,
            })}
          </Text>
        </Box>
        {pending.simulatedCode ? (
          <Box row gap={2} align="center">
            <SimulatedBadge />
            <Text variant="caption">
              {t("wallet:linked.bank.codeSimulated", { code: pending.simulatedCode })}
            </Text>
          </Box>
        ) : null}
        <Input
          label={t("wallet:linked.bank.code")}
          value={code}
          onChangeText={(v) => setCode(v.replace(/\D/g, "").slice(0, 4))}
          keyboardType="number-pad"
          maxLength={4}
          testID="link-bank-code"
        />
        {error ? <Text color="destructive">{error}</Text> : null}
        <Button size="lg" onPress={() => void finish()} loading={confirmLink.isPending}>
          {t("wallet:linked.bank.confirm")}
        </Button>
        <Button variant="ghost" onPress={onDone}>
          {t("common:cancel")}
        </Button>
      </Box>
    );
  }

  return (
    <Box p={5} gap={4}>
      <Box gap={1}>
        <Box row justify="between" align="center">
          <Text variant="heading">{t("wallet:linked.bank.title")}</Text>
          <SimulatedBadge />
        </Box>
        <Text variant="caption">{t("wallet:linked.bank.body")}</Text>
      </Box>
      <Box gap={2}>
        <Text variant="label">{t("wallet:linked.bank.bank")}</Text>
        <ChipRow
          options={BANKS.map((b) => ({
            value: b,
            label: b === "OTHER" ? t("wallet:linked.bank.other") : b,
          }))}
          value={bank}
          onChange={setBank}
          testIDPrefix="link-bank"
        />
      </Box>
      {bank === "OTHER" ? (
        <Input
          label={t("wallet:linked.bank.bankName")}
          value={otherName}
          onChangeText={setOtherName}
        />
      ) : null}
      <Input
        label={t("wallet:linked.bank.account")}
        value={account}
        onChangeText={setAccount}
        autoCapitalize="characters"
        placeholder="KZ12 722C 0000 1234 4417"
        testID="link-bank-account"
      />
      <SettingPicker
        label={t("wallet:linked.bank.currency")}
        value={currency}
        options={currencyOptions}
        onChange={setCurrency}
        testID="link-bank-currency"
      />
      {error ? <Text color="destructive">{error}</Text> : null}
      <Button size="lg" onPress={() => void begin()} loading={start.isPending}>
        {t("wallet:linked.bank.continue")}
      </Button>
      <Button variant="ghost" onPress={onDone}>
        {t("common:cancel")}
      </Button>
    </Box>
  );
}

type SheetState = { kind: "card" } | { kind: "bank"; resume: FundingSourceDto | null } | null;

/** Settings > Linked accounts: cards and banks you send from, next to the Kassa wallet. */
export function LinkedAccountsScreen({ viewOnly = false }: { viewOnly?: boolean }) {
  const t = useKassaT();
  const sources = useFundingSources();
  const remove = useRemoveFundingSource();
  // Opened from KassaLite (`?from=lite&intent=card|bank`): open that form at once, and send the person back after it.
  const params = useLocalSearchParams<{ from?: string; intent?: string }>();
  const fromLite = params.from === "lite";
  const [sheet, setSheet] = useState<SheetState>(() =>
    viewOnly
      ? null
      : params.intent === "card"
        ? { kind: "card" }
        : params.intent === "bank"
          ? { kind: "bank", resume: null }
          : null
  );
  const [webUnavailable, setWebUnavailable] = useState(false);
  const close = () => {
    setSheet(null);
    if (fromLite) void Linking.openURL(`${LITE_RETURN_URL}linked-accounts`).catch(() => {});
  };
  const linkInWebApp = async (intent: "card" | "bank") => {
    const opened = await openWebAppStep("/linked-accounts", { intent });
    setWebUnavailable(!opened);
  };

  const onRemove = async (s: FundingSourceDto) => {
    const ok = await confirm({
      title: t("wallet:linked.removeTitle", { label: s.label }),
      message: t("wallet:linked.removeBody"),
      confirmLabel: t("wallet:linked.remove"),
      cancelLabel: t("common:cancel"),
      destructive: true,
    });
    if (!ok) return;
    try {
      await remove.mutateAsync(s.id);
      toast.show({ title: t("wallet:linked.removed") });
    } catch (err) {
      toast.show({ title: errorText(t, err), kind: "error" });
    }
  };

  return (
    <ScrollScreen testID="linked-accounts">
      <Card>
        <Box gap={2}>
          <Text>{t("wallet:linked.intro")}</Text>
          <Box row gap={2} align="center">
            <SimulatedBadge />
            <Text variant="caption" style={{ flex: 1 }}>
              {t("wallet:linked.testMode")}
            </Text>
          </Box>
        </Box>
      </Card>
      <QueryView query={sources} skeletonRows={2}>
        {(data) =>
          data.sources.length === 0 ? (
            <Card>
              <Text variant="caption">{t("wallet:linked.empty")}</Text>
            </Card>
          ) : (
            <RowGroup title={t("wallet:linked.title")} icons>
              {data.sources.map((s) => {
                const icon = sourceIcon(s);
                return (
                  <Row
                    key={s.id}
                    testID={`linked-${s.id}`}
                    leading={
                      <Icon
                        name={icon.name}
                        fallback={icon.fallback}
                        size={20}
                        color="brandAccent"
                      />
                    }
                    title={s.label}
                    subtitle={[
                      s.currency,
                      t(`wallet:kind.${s.kind}`),
                      ...(s.status === "PENDING" ? [t("wallet:linked.pending")] : []),
                    ].join(" · ")}
                    trailing={
                      viewOnly ? undefined : (
                        <View style={{ flexDirection: "row", gap: 4 }}>
                          {s.status === "PENDING" ? (
                            <Button
                              size="sm"
                              variant="secondary"
                              onPress={() =>
                                setSheet(
                                  s.kind === "BANK" ? { kind: "bank", resume: s } : { kind: "card" }
                                )
                              }
                            >
                              {t("wallet:linked.finish")}
                            </Button>
                          ) : null}
                          <Button size="sm" variant="ghost" onPress={() => void onRemove(s)}>
                            {t("wallet:linked.remove")}
                          </Button>
                        </View>
                      )
                    }
                  />
                );
              })}
            </RowGroup>
          )
        }
      </QueryView>
      {viewOnly ? (
        // KassaLite has no passkey: linking happens on the web app's page, which sends the person back here.
        <Box gap={2}>
          <Button size="lg" onPress={() => void linkInWebApp("card")}>
            {t("wallet:linked.linkCardWeb")}
          </Button>
          <Button variant="secondary" onPress={() => void linkInWebApp("bank")}>
            {t("wallet:linked.linkBankWeb")}
          </Button>
          <Text variant="caption">
            {t(webUnavailable ? "wallet:linked.webUnavailable" : "wallet:linked.viewOnly")}
          </Text>
        </Box>
      ) : (
        <Box gap={2}>
          <Button size="lg" onPress={() => setSheet({ kind: "card" })}>
            {t("wallet:linked.linkCard")}
          </Button>
          <Button variant="secondary" onPress={() => setSheet({ kind: "bank", resume: null })}>
            {t("wallet:linked.linkBank")}
          </Button>
        </Box>
      )}
      <Sheet visible={sheet !== null} onClose={close} detents={["full"]}>
        {sheet?.kind === "card" ? <LinkCardForm onDone={close} /> : null}
        {sheet?.kind === "bank" ? <LinkBankForm onDone={close} resume={sheet.resume} /> : null}
      </Sheet>
    </ScrollScreen>
  );
}
