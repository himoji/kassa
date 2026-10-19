import {
  kindForCategory,
  maskPayeeAccount,
  type PayoutScheme,
  type RecipientCategory,
} from "@kassa/shared";
import { useMemo, useState } from "react";
import { Pressable, View } from "react-native";

import { KassaApiError } from "@/api/errors";
import { useCreatePayee } from "@/api/hooks/payees";
import { errorText } from "@/components/kassa/error-text";
import { SettingPicker } from "@/components/kassa/native-controls";
import { Segmented } from "@/components/kassa/segmented";
import { Box, Button, Card, Icon, Input, Text, toast } from "@/components/ui";
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

import { FindSchool } from "./find-school";
import {
  CATEGORY_ICON,
  CategoryTiles,
  EMPTY_DETAILS,
  formToDetails,
  RecipientDetailsFields,
  type DetailsForm,
} from "./recipient-fields";

type FieldKey =
  "iban" | "alipayId" | "cardNumber" | "routingNumber" | "accountNumber" | "kassaId" | "value";

/** Which form input a problem's field belongs to (OTHER's `value` is the `other` input). */
const PROBLEM_FIELD: Record<string, FieldKey> = {
  iban: "iban",
  alipayId: "alipayId",
  cardNumber: "cardNumber",
  routingNumber: "routingNumber",
  accountNumber: "accountNumber",
  kassaId: "kassaId",
  value: "value",
};

/**
 * Add a recipient in two steps. First "What are you paying?" (people, tuition, rent, bills, shops), then that
 * category's own details (a student ID and the school's portal, a customer number, a relationship) and the account
 * the way their country pays (spec §16): SEPA IBAN; China Alipay ID or UnionPay card; US routing + account number.
 * Each field is checked here as on the server (shared/payeeAccount.ts, shared/recipient.ts), so a typo is caught
 * before the 24-hour cooling period starts.
 */
export function AddPayeeForm({
  onClose: close,
  initialCategory = null,
}: {
  onClose: () => void;
  /** Skip the category step (opened from a category tab). */
  initialCategory?: RecipientCategory | null;
}) {
  const t = useKassaT();
  const f = useFormat();
  const create = useCreatePayee();
  // undefined = not picked in this sheet yet: start from the tab it was opened from.
  const [picked, setCategory] = useState<RecipientCategory | null | undefined>(undefined);
  const category = picked === undefined ? initialCategory : picked;
  const [details, setDetails] = useState<DetailsForm>(EMPTY_DETAILS);
  // Tuition starts with "Find your school"; typing the school's account by hand is the fallback.
  const [manualTuition, setManualTuition] = useState(false);
  const [name, setName] = useState("");
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
  const detailsCheck = category ? formToDetails(category, details) : null;
  const kind = category
    ? kindForCategory(category, detailsCheck?.ok ? detailsCheck.details : null)
    : "PERSON";

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

  const detailError = (key: keyof DetailsForm): string | undefined => {
    if (serverError?.field === "details")
      return key === "studentId" || key === "customerNumber" ? serverError.text : undefined;
    if (!showErrors || !detailsCheck || detailsCheck.ok || detailsCheck.field !== key)
      return undefined;
    return t(`payees:add.errors.${detailsCheck.code}`);
  };

  const onClose = () => {
    reset();
    close();
  };

  const reset = () => {
    setName("");
    setDetails(EMPTY_DETAILS);
    setCategory(undefined);
    setManualTuition(false);
    setFields(EMPTY_PAYEE_FIELDS);
    setShowErrors(false);
    setServerError(null);
  };

  const submit = async () => {
    setShowErrors(true);
    setServerError(null);
    if (nameMissing || !check.ok || !detailsCheck?.ok) {
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
        details: detailsCheck.details,
      });
      haptics.success();
      toast.show({ title: t("payees:add.created"), description: t("payees:add.coolingNote") });
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
    <>
      {category === null ? (
        <Box gap={4}>
          <Box gap={1}>
            <Text variant="heading">{t("payees:add.pickCategory")}</Text>
            <Text variant="caption">{t("payees:add.coolingNote")}</Text>
          </Box>
          <CategoryTiles onPick={setCategory} />
          <Button variant="ghost" onPress={onClose}>
            {t("common:cancel")}
          </Button>
        </Box>
      ) : category === "TUITION" && !manualTuition ? (
        <Box gap={4}>
          <Box gap={1}>
            <Text variant="heading">{t("payees:school.title")}</Text>
            <Text variant="caption">{t("payees:school.body")}</Text>
          </Box>
          <FindSchool onDone={onClose} onManual={() => setManualTuition(true)} />
          <Button variant="ghost" onPress={() => setCategory(null)}>
            {t("payees:school.otherCategory")}
          </Button>
        </Box>
      ) : (
        <Box gap={4}>
          <Text variant="caption">{t("payees:add.coolingNote")}</Text>

          <Pressable
            onPress={() => setCategory(null)}
            accessibilityRole="button"
            accessibilityLabel={`${t("payees:add.kind")}: ${t(`payees:category.${category}`)}. ${t("payees:add.changeCategory")}`}
            style={{ flexDirection: "row", alignItems: "center", gap: 10, minHeight: 44 }}
            testID="recipient-category-current"
          >
            <Icon
              name={CATEGORY_ICON[category].sf}
              fallback={CATEGORY_ICON[category].md}
              size={22}
              color="brandAccent"
            />
            <Text weight="semibold" style={{ flex: 1 }}>
              {t(`payees:category.${category}`)}
            </Text>
            <Text color="brandAccent">{t("payees:add.changeCategory")}</Text>
          </Pressable>

          <Input
            label={t(`payees:add.nameFor.${category}`)}
            value={name}
            onChangeText={setName}
            autoCapitalize="words"
            error={showErrors && nameMissing ? t("payees:add.errors.NAME_MISSING") : undefined}
          />

          <RecipientDetailsFields
            category={category}
            form={details}
            onChange={(patch) => {
              setServerError(null);
              setDetails((prev) => ({ ...prev, ...patch }));
            }}
            errorFor={detailError}
          />

          <View style={{ marginHorizontal: -16 }}>
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
          {scheme === "KASSA_USER" ? (
            <Input
              label={t("payees:add.kassaId")}
              value={fields.kassaId}
              onChangeText={(v) => set({ kassaId: v })}
              autoCapitalize="characters"
              placeholder="KSA-7QMX-2HVA"
              error={fieldError("kassaId")}
            />
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
                    kind: t(`payees:category.${category}`),
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
      )}
    </>
  );
}
