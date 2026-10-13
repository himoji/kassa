import { maskPayeeAccount, PayeeKind, type PayoutScheme } from "@kassa/shared";
import { useMemo, useState } from "react";
import { View } from "react-native";

import { KassaApiError } from "@/api/errors";
import { useCreatePayee } from "@/api/hooks/payees";
import { errorText } from "@/components/kassa/error-text";
import { SettingPicker } from "@/components/kassa/native-controls";
import { Segmented } from "@/components/kassa/segmented";
import { Box, Button, Card, Input, Sheet, Text, toast } from "@/components/ui";
import { countryOptions } from "@/lib/countries";
import { useFormat } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { useKassaT } from "@/lib/i18n";
import {
  checkPayeeForm,
  EMPTY_PAYEE_FIELDS,
  PAYEE_CURRENCIES,
  schemesAndChoice,
  usualCurrency,
  type PayeeFormFields,
} from "@/lib/payee-form";

type FieldKey = "iban" | "alipayId" | "cardNumber" | "routingNumber" | "accountNumber" | "value";

/** Which form input a problem's field belongs to (OTHER's `value` is the `other` input). */
const PROBLEM_FIELD: Record<string, FieldKey> = {
  iban: "iban",
  alipayId: "alipayId",
  cardNumber: "cardNumber",
  routingNumber: "routingNumber",
  accountNumber: "accountNumber",
  value: "value",
};

/**
 * Add a payee the way their country pays (spec §16): name, country and currency first, then only the fields that
 * scheme needs (SEPA: IBAN; China: Alipay ID or UnionPay card; US: routing + account number). Each field is checked
 * here as on the server (shared/payeeAccount.ts), so a typo is caught before the 24-hour cooling period starts.
 */
export function AddPayeeSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const t = useKassaT();
  const f = useFormat();
  const create = useCreatePayee();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<PayeeKind>("PERSON");
  const [country, setCountry] = useState("HU");
  const [currency, setCurrency] = useState("HUF");
  const [fields, setFields] = useState<PayeeFormFields>(EMPTY_PAYEE_FIELDS);
  const [showErrors, setShowErrors] = useState(false);
  const [serverError, setServerError] = useState<{ field: string | null; text: string } | null>(
    null
  );
  const countries = useMemo(() => countryOptions(), []);
  const currencies = useMemo(
    () => PAYEE_CURRENCIES.map((c) => ({ value: c, label: `${c} · ${f.currencyName(c)}` })),
    [f]
  );

  const { schemes, scheme } = schemesAndChoice(country, currency, fields.scheme);
  const form = { ...fields, scheme };
  const check = checkPayeeForm(form, currency);
  const nameMissing = !name.trim();

  const set = (patch: Partial<PayeeFormFields>) => {
    setServerError(null);
    setFields((prev) => ({ ...prev, ...patch }));
  };
  const fieldError = (key: FieldKey): string | undefined => {
    if (serverError?.field === key) return serverError.text;
    if (!showErrors || check.ok || PROBLEM_FIELD[check.problem.field] !== key) return undefined;
    return t(`payees:add.errors.${check.problem.code}`);
  };
  const currencyError =
    !check.ok && check.problem.field === "currency"
      ? t("payees:add.errors.SCHEME_CURRENCY_MISMATCH")
      : undefined;

  const reset = () => {
    setName("");
    setFields(EMPTY_PAYEE_FIELDS);
    setShowErrors(false);
    setServerError(null);
  };

  const submit = async () => {
    setShowErrors(true);
    setServerError(null);
    if (nameMissing || !check.ok) {
      haptics.error();
      return;
    }
    try {
      await create.mutateAsync({
        name: name.trim(),
        kind,
        account: check.account,
        country,
        currency,
      });
      haptics.success();
      toast.show({ title: t("payees:add.created"), description: t("payees:add.coolingNote") });
      reset();
      onClose();
    } catch (err) {
      haptics.error();
      const field =
        err instanceof KassaApiError
          ? ((err.details as { field?: string } | undefined)?.field ?? null)
          : null;
      const known =
        err instanceof KassaApiError &&
        err.code &&
        t(`payees:add.errors.${err.code}`, { defaultValue: "" });
      setServerError({ field, text: known || errorText(t, err) });
    }
  };

  const schemeLabel = (s: PayoutScheme) => t(`payees:scheme.${s}.short`);

  return (
    <Sheet visible={visible} onClose={onClose} detents={["full"]}>
      <Box p={5} gap={4}>
        <Box gap={1}>
          <Text variant="heading">{t("payees:add.title")}</Text>
          <Text variant="caption">{t("payees:add.coolingNote")}</Text>
        </Box>

        <Input
          label={t("payees:add.name")}
          value={name}
          onChangeText={setName}
          autoCapitalize="words"
          error={showErrors && nameMissing ? t("payees:add.errors.NAME_MISSING") : undefined}
        />

        <View style={{ marginHorizontal: -16 }}>
          <SettingPicker
            label={t("payees:add.kind")}
            value={kind}
            options={PayeeKind.options.map((k) => ({ value: k, label: t(`payees:kind.${k}`) }))}
            onChange={setKind}
          />
          <SettingPicker
            label={t("payees:add.country")}
            value={country}
            options={countries}
            onChange={(c) => {
              setCountry(c);
              const usual = usualCurrency(c);
              if (usual) setCurrency(usual);
            }}
            testID="payee-country"
          />
          <SettingPicker
            label={t("payees:add.currency")}
            value={currency}
            options={currencies}
            onChange={setCurrency}
            testID="payee-currency"
          />
        </View>
        {currencyError ? <Text color="destructive">{currencyError}</Text> : null}

        <Box gap={2}>
          <Text variant="label">{t("payees:add.how")}</Text>
          {schemes.length > 1 ? (
            <Segmented
              value={scheme}
              onChange={(s) => set({ scheme: s })}
              options={schemes.map((s) => ({ value: s, label: schemeLabel(s) }))}
            />
          ) : null}
          <Text variant="caption">{t(`payees:scheme.${scheme}.hint`)}</Text>
        </Box>

        {scheme === "IBAN" ? (
          <Input
            label={t("payees:add.iban")}
            value={fields.iban}
            onChangeText={(v) => set({ iban: v })}
            autoCapitalize="characters"
            placeholder="DE89 3704 0044 0532 0130 00"
            error={fieldError("iban")}
          />
        ) : null}
        {scheme === "CN_ALIPAY" ? (
          <Input
            label={t("payees:add.alipayId")}
            value={fields.alipayId}
            onChangeText={(v) => set({ alipayId: v })}
            autoCapitalize="none"
            keyboardType="email-address"
            placeholder="name@example.cn · 138 0013 8000"
            error={fieldError("alipayId")}
          />
        ) : null}
        {scheme === "CN_UNIONPAY" ? (
          <Input
            label={t("payees:add.cardNumber")}
            value={fields.cardNumber}
            onChangeText={(v) => set({ cardNumber: v })}
            keyboardType="number-pad"
            placeholder="6200 0000 0000 0005"
            error={fieldError("cardNumber")}
          />
        ) : null}
        {scheme === "US_ACH" ? (
          <>
            <Input
              label={t("payees:add.routingNumber")}
              value={fields.routingNumber}
              onChangeText={(v) => set({ routingNumber: v })}
              keyboardType="number-pad"
              placeholder="021000021"
              error={fieldError("routingNumber")}
            />
            <Input
              label={t("payees:add.accountNumber")}
              value={fields.accountNumber}
              onChangeText={(v) => set({ accountNumber: v })}
              keyboardType="number-pad"
              error={fieldError("accountNumber")}
            />
            <Segmented
              value={fields.accountType}
              onChange={(v) => set({ accountType: v })}
              options={[
                { value: "CHECKING", label: t("payees:add.checking") },
                { value: "SAVINGS", label: t("payees:add.savings") },
              ]}
            />
          </>
        ) : null}
        {scheme === "OTHER" ? (
          <Input
            label={t("payees:add.other")}
            value={fields.other}
            onChangeText={(v) => set({ other: v })}
            error={fieldError("value")}
          />
        ) : null}

        {check.ok && !nameMissing ? (
          <Card>
            <Box gap={1}>
              <Text variant="caption">{t("payees:add.preview")}</Text>
              <Text weight="semibold">{name.trim()}</Text>
              <Text variant="caption">
                {t("payees:meta", {
                  kind: t(`payees:kind.${kind}`),
                  account: maskPayeeAccount(check.account),
                  country,
                  currency,
                })}
              </Text>
            </Box>
          </Card>
        ) : null}

        {serverError && !(serverError.field && serverError.field in PROBLEM_FIELD) ? (
          <Text color="destructive">{serverError.text}</Text>
        ) : null}
        <Button size="lg" onPress={() => void submit()} loading={create.isPending}>
          {t("payees:add.submit")}
        </Button>
        <Button variant="ghost" onPress={onClose}>
          {t("common:cancel")}
        </Button>
      </Box>
    </Sheet>
  );
}
