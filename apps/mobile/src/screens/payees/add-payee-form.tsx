import { kindForCategory, type PayoutScheme, type RecipientCategory } from "@kassa/shared";
import { useMemo, useState } from "react";
import { Pressable, View } from "react-native";

import { KassaApiError } from "@/api/errors";
import { useCreatePayee } from "@/api/hooks/payees";
import { errorText } from "@/components/kassa/error-text";
import { SettingPicker } from "@/components/kassa/native-controls";
import { Segmented } from "@/components/kassa/segmented";
import { Box, Button, Icon, Input, Text, toast } from "@/components/ui";
import { countryName, countryOptions } from "@/lib/countries";
import { useFormat } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { useKassaT } from "@/lib/i18n";
import {
  checkPayeeForm,
  EMPTY_PAYEE_FIELDS,
  ibanCountry,
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
  REQUIRED_DETAILS,
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
 * Add a recipient in two steps. First "What are you paying?" (people, tuition, rent, bills, shops), then a short
 * step: how they get paid, the name, the account the way their country pays (spec §16: SEPA IBAN; China Alipay ID or
 * UnionPay card; US routing + account number) and only the details the category can't do without. The country and
 * currency are read from the IBAN (HU… → Hungary · HUF) and shown as one line; the category's optional details (a
 * relationship, a note, a KNP code, a portal link) and the country pickers sit behind "More details".
 * Each field is checked here as on the server (shared/payeeAccount.ts, shared/recipient.ts), so a typo is caught
 * before the 24-hour cooling period starts; "Add recipient" stays disabled until everything required is valid.
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
  // Inputs the user has left: their errors show from then on (the button is disabled, so it never reveals them).
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const [moreOpen, setMoreOpen] = useState(false);
  // "Edit" on the inferred country line: the pickers show inline and the IBAN no longer overrides them.
  const [placeOpen, setPlaceOpen] = useState(false);
  const [placeEdited, setPlaceEdited] = useState(false);
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

  const touch = (key: string) =>
    setTouched((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
  const set = (patch: Partial<PayeeFormFields>) => {
    setServerError(null);
    setFields((prev) => ({ ...prev, ...patch }));
  };
  const setIban = (iban: string) => {
    set({ iban });
    const guessed = placeEdited ? null : ibanCountry(iban);
    if (guessed) {
      setCountry(guessed);
      const usual = usualCurrency(guessed);
      if (usual) setCurrency(usual);
    }
  };
  const fieldError = (key: FieldKey): string | undefined => {
    if (serverError?.field === key) return serverError.text;
    if (!(showErrors || touched.has(key)) || check.ok || PROBLEM_FIELD[check.problem.field] !== key)
      return undefined;
    return t(`payees:add.errors.${check.problem.code}`);
  };
  const currencyError =
    !check.ok && check.problem.field === "currency"
      ? t("payees:add.errors.SCHEME_CURRENCY_MISMATCH")
      : undefined;

  const detailError = (key: keyof DetailsForm): string | undefined => {
    if (serverError?.field === "details")
      return key === "studentId" || key === "customerNumber" ? serverError.text : undefined;
    if (!(showErrors || touched.has(`details.${key}`))) return undefined;
    if (!detailsCheck || detailsCheck.ok || detailsCheck.field !== key) return undefined;
    return t(`payees:add.errors.${detailsCheck.code}`);
  };

  const updateDetails = (patch: Partial<DetailsForm>) => {
    setServerError(null);
    setDetails((prev) => ({ ...prev, ...patch }));
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
    setTouched(new Set());
    setMoreOpen(false);
    setPlaceOpen(false);
    setPlaceEdited(false);
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
  const ready = !nameMissing && check.ok && Boolean(detailsCheck?.ok);
  const requiredDetail = category ? REQUIRED_DETAILS[category] : undefined;
  // An optional detail that fails its check (a 2-digit KNP) keeps the section open, so the reason stays in view.
  const optionalInvalid =
    detailsCheck !== null && !detailsCheck.ok && detailsCheck.field !== requiredDetail;
  const detailsOpen = moreOpen || optionalInvalid;
  // The country and currency read from the IBAN: one quiet line instead of two pickers.
  const placeLine = !placeOpen && scheme === "IBAN" && ibanCountry(fields.iban) !== null;
  const pickPlace = (c: string) => {
    setPlaceEdited(true);
    setCountry(c);
    const usual = usualCurrency(c);
    if (usual) setCurrency(usual);
  };
  const placePickers = (
    <View style={{ marginHorizontal: -16 }}>
      <SettingPicker
        label={t("payees:add.country")}
        value={country}
        options={countries}
        onChange={pickPlace}
        testID="payee-country"
      />
      <SettingPicker
        label={t("payees:add.currency")}
        value={currency}
        options={currencies}
        onChange={(c) => {
          setPlaceEdited(true);
          setCurrency(c);
        }}
        testID="payee-currency"
      />
    </View>
  );

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

          {schemes.length > 1 ? (
            <Box gap={2}>
              <Text variant="label">{t("payees:add.how")}</Text>
              <Segmented
                value={scheme}
                onChange={(s) => set({ scheme: s })}
                options={schemes.map((s) => ({ value: s, label: schemeLabel(s) }))}
              />
            </Box>
          ) : null}

          <Input
            label={t(`payees:add.nameFor.${category}`)}
            value={name}
            onChangeText={setName}
            autoCapitalize="words"
            error={showErrors && nameMissing ? t("payees:add.errors.NAME_MISSING") : undefined}
            testID="payee-name"
          />

          {scheme === "IBAN" ? (
            <Box gap={1}>
              <Input
                label={t("payees:add.iban")}
                value={fields.iban}
                onChangeText={setIban}
                onBlur={() => touch("iban")}
                autoCapitalize="characters"
                placeholder="DE89 3704 0044 0532 0130 00"
                error={fieldError("iban")}
                testID="payee-iban"
              />
              {placeLine ? (
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <Text variant="caption" style={{ flex: 1 }} testID="payee-place">
                    {t("payees:add.place", {
                      country: countryName(country) ?? country,
                      currency,
                    })}
                  </Text>
                  <Pressable
                    onPress={() => setPlaceOpen(true)}
                    accessibilityRole="button"
                    accessibilityLabel={`${t("payees:add.country")}, ${t("payees:add.currency")}: ${t("payees:add.editPlace")}`}
                    hitSlop={12}
                    testID="payee-place-edit"
                  >
                    <Text variant="caption" color="brandAccent">
                      {t("payees:add.editPlace")}
                    </Text>
                  </Pressable>
                </View>
              ) : null}
            </Box>
          ) : null}
          {scheme === "CN_ALIPAY" ? (
            <Input
              label={t("payees:add.alipayId")}
              value={fields.alipayId}
              onChangeText={(v) => set({ alipayId: v })}
              onBlur={() => touch("alipayId")}
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
              onBlur={() => touch("cardNumber")}
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
                onBlur={() => touch("routingNumber")}
                keyboardType="number-pad"
                placeholder="021000021"
                error={fieldError("routingNumber")}
              />
              <Input
                label={t("payees:add.accountNumber")}
                value={fields.accountNumber}
                onChangeText={(v) => set({ accountNumber: v })}
                onBlur={() => touch("accountNumber")}
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
              onBlur={() => touch("kassaId")}
              autoCapitalize="characters"
              placeholder="KSA-7QMX-2HVA"
              error={fieldError("kassaId")}
              testID="payee-kassa-id"
            />
          ) : null}
          {scheme === "OTHER" ? (
            <Input
              label={t("payees:add.other")}
              value={fields.other}
              onChangeText={(v) => set({ other: v })}
              onBlur={() => touch("value")}
              error={fieldError("value")}
              testID="payee-other"
            />
          ) : null}

          {placeOpen ? placePickers : null}
          {currencyError ? <Text color="destructive">{currencyError}</Text> : null}

          {requiredDetail ? (
            <RecipientDetailsFields
              category={category}
              form={details}
              onChange={updateDetails}
              errorFor={detailError}
              onTouch={(k) => touch(`details.${k}`)}
              part="required"
            />
          ) : null}

          <Box gap={3}>
            <Pressable
              onPress={() => setMoreOpen(!detailsOpen)}
              disabled={optionalInvalid}
              accessibilityRole="button"
              accessibilityState={{ expanded: detailsOpen }}
              style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 44 }}
              testID="payee-more-details"
            >
              <Text style={{ flex: 1 }} color="mutedForeground">
                {t("payees:add.moreDetails")}
              </Text>
              <Icon
                name={detailsOpen ? "chevron.up" : "chevron.down"}
                fallback={detailsOpen ? "expand_less" : "expand_more"}
                size={16}
                color="mutedForeground"
              />
            </Pressable>
            {detailsOpen ? (
              <Box gap={3}>
                <Text variant="caption">{t(`payees:add.schemeNote.${scheme}`)}</Text>
                <RecipientDetailsFields
                  category={category}
                  form={details}
                  onChange={updateDetails}
                  errorFor={detailError}
                  onTouch={(k) => touch(`details.${k}`)}
                  part="optional"
                />
                {placeOpen || placeLine ? null : placePickers}
              </Box>
            ) : null}
          </Box>

          {serverError && !(serverError.field && serverError.field in PROBLEM_FIELD) ? (
            <Text color="destructive">{serverError.text}</Text>
          ) : null}
          <Box gap={2}>
            <Text variant="caption" style={{ textAlign: "center" }} testID="payee-cooling-note">
              {t("payees:add.coolingShort")}
            </Text>
            <Button
              size="lg"
              onPress={() => void submit()}
              loading={create.isPending}
              disabled={!ready}
            >
              {t("payees:add.submit")}
            </Button>
            <Button variant="ghost" onPress={onClose}>
              {t("common:cancel")}
            </Button>
          </Box>
        </Box>
      )}
    </>
  );
}
