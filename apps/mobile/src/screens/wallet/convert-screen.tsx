import { FEATURED_CURRENCIES, ReasonCode, SupportedCurrency } from "@kassa/shared";
import { router, useLocalSearchParams } from "expo-router";
import { useMemo, useState } from "react";

import { useBalances } from "@/api/hooks/money";
import { useConvert } from "@/api/hooks/wallet";
import { errorText } from "@/components/kassa/error-text";
import { MoneyInput } from "@/components/kassa/money-input";
import { SettingPicker } from "@/components/kassa/native-controls";
import { ReasonCodeList } from "@/components/kassa/reason-codes";
import { ScrollScreen } from "@/components/kassa/scroll-screen";
import { Box, Button, Card, Text } from "@/components/ui";
import { currencyCodes, useFormat } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { useKassaT } from "@/lib/i18n";

/** Currencies the wallet holds (the server refuses any other with BAD_CURRENCY), the demo's own first. */
const CURRENCIES: readonly string[] = currencyCodes().filter((c) =>
  (SupportedCurrency.options as readonly string[]).includes(c)
);

function currencyParam(value: string | undefined): string | null {
  return value && CURRENCIES.includes(value) ? value : null;
}

function amountParam(value: string | undefined): number | null {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** One row of currency choices (wraps on small screens); `null` is the optional "cheapest balance" choice. */
function CurrencyChoice({
  value,
  options,
  onChange,
  cheapestLabel,
}: {
  value: string | null;
  options: readonly string[];
  onChange: (currency: string | null) => void;
  cheapestLabel?: string;
}) {
  return (
    <Box row gap={2} style={{ flexWrap: "wrap" }}>
      {cheapestLabel ? (
        <Button
          size="sm"
          variant={value === null ? "primary" : "outline"}
          onPress={() => onChange(null)}
        >
          {cheapestLabel}
        </Button>
      ) : null}
      {options.map((c) => (
        <Button
          key={c}
          size="sm"
          variant={value === c ? "primary" : "outline"}
          onPress={() => onChange(c)}
        >
          {c}
        </Button>
      ))}
    </Box>
  );
}

/**
 * Convert between the user's own balances: into which currency, how much to receive, from which balance (or the
 * cheapest). This only proposes it: POST /conversions comes back as a CONVERT order, and the order sheet asks for
 * the passkey over the exact order (always). Bills that need converting first open this prefilled
 * (`fromCurrency`, `toCurrency`, `amountMinor` in minor units).
 */
export function ConvertScreen() {
  const t = useKassaT();
  const f = useFormat();
  const params = useLocalSearchParams<{
    fromCurrency?: string;
    toCurrency?: string;
    amountMinor?: string;
  }>();
  const balances = useBalances();
  const convert = useConvert();
  const [to, setTo] = useState<string>(() => currencyParam(params.toCurrency) ?? "EUR");
  const [from, setFrom] = useState<string | null>(() => {
    const p = currencyParam(params.fromCurrency);
    return p && p !== to ? p : null;
  });
  const [amountMinor, setAmountMinor] = useState<number | null>(() =>
    amountParam(params.amountMinor)
  );
  const [error, setError] = useState<string | null>(null);
  const [refused, setRefused] = useState<{ codes: ReasonCode[]; summary: string } | null>(null);

  const held = from ? balances.data?.balances.find((b) => b.currency === from) : undefined;
  const toOptions = useMemo(
    () => CURRENCIES.map((c) => ({ value: c, label: `${c} · ${f.currencyName(c)}` })),
    [f]
  );
  // Funding chips: the demo's currencies and every currency with a balance (a long list of empty ones helps nobody).
  const fromOptions = useMemo(() => {
    const heldCodes = (balances.data?.balances ?? [])
      .filter((b) => b.amountMinor > 0)
      .map((b) => b.currency);
    return CURRENCIES.filter(
      (c) =>
        c !== to &&
        ((FEATURED_CURRENCIES as readonly string[]).includes(c) ||
          heldCodes.includes(c) ||
          c === from)
    );
  }, [balances.data, to, from]);

  const submit = async () => {
    setError(null);
    setRefused(null);
    if (!amountMinor) {
      setError(t("wallet:errors.AMOUNT"));
      haptics.error();
      return;
    }
    if (from === to) {
      setError(t("wallet:convert.sameCurrency"));
      haptics.error();
      return;
    }
    try {
      const res = await convert.mutateAsync({
        toCurrency: to,
        amountMinor,
        ...(from ? { fromCurrency: from } : {}),
      });
      if (res.decision === "ASK") {
        haptics.success();
        router.push(`/order/${res.proposalId}`);
        return;
      }
      // Not enough in any balance, balances unreadable, or frozen: nothing to sign, say why.
      haptics.warning();
      setRefused({
        codes: res.reasonCodes.filter((c): c is ReasonCode => ReasonCode.safeParse(c).success),
        summary: res.summary,
      });
    } catch (err) {
      haptics.error();
      setError(errorText(t, err));
    }
  };

  return (
    <ScrollScreen testID="convert">
      <Card>
        <Text variant="caption">{t("wallet:convert.intro")}</Text>
      </Card>

      <SettingPicker
        label={t("wallet:convert.to")}
        value={to}
        options={toOptions}
        onChange={(c) => {
          if (!c || c === to) return;
          setTo(c);
          if (from === c) setFrom(null);
          // An amount typed in another currency means something else now.
          setAmountMinor(null);
          setRefused(null);
        }}
        testID="convert-to"
      />

      <Box gap={2}>
        <Text variant="label">{t("wallet:convert.amount")}</Text>
        <MoneyInput
          testID="convert-amount"
          valueMinor={amountMinor}
          currency={to}
          onChange={setAmountMinor}
          accessibilityLabel={t("wallet:convert.amount")}
        />
      </Box>

      <Box gap={2}>
        <Text variant="label">{t("wallet:convert.from")}</Text>
        <CurrencyChoice
          value={from}
          options={fromOptions}
          onChange={(c) => {
            setFrom(c);
            setRefused(null);
          }}
          cheapestLabel={t("wallet:convert.cheapest")}
        />
        {from === null ? (
          <Text variant="caption">{t("wallet:convert.cheapestHint")}</Text>
        ) : held ? (
          <Text variant="caption">
            {t("wallet:convert.have", { amount: f.money(held.amountMinor, held.currency) })}
          </Text>
        ) : null}
      </Box>

      {refused ? (
        <Card>
          <Box gap={2} testID="convert-refused">
            <Text weight="semibold">{t("wallet:convert.refused")}</Text>
            {refused.codes.length > 0 ? (
              <ReasonCodeList codes={refused.codes} />
            ) : (
              <Text variant="caption">{refused.summary}</Text>
            )}
          </Box>
        </Card>
      ) : null}
      {error ? <Text color="destructive">{error}</Text> : null}

      <Box gap={2}>
        <Button size="lg" onPress={() => void submit()} loading={convert.isPending}>
          {t("wallet:convert.submit")}
        </Button>
        <Text variant="caption" align="center">
          {t("wallet:reviewHint")}
        </Text>
      </Box>
    </ScrollScreen>
  );
}
