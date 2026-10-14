import { BillType, RecipientDetails, Relationship, type RecipientCategory } from "@kassa/shared";
import { Pressable, ScrollView, View } from "react-native";

import { SettingPicker } from "@/components/kassa/native-controls";
import { Box, Icon, Input, Text, useTheme } from "@/components/ui";
import { useKassaT } from "@/lib/i18n";

/** SF Symbol / Material Symbol per recipient category. */
export const CATEGORY_ICON: Record<RecipientCategory, { sf: string; md: string }> = {
  PEOPLE: { sf: "person.2.fill", md: "group" },
  TUITION: { sf: "graduationcap.fill", md: "school" },
  RENT: { sf: "house.fill", md: "home" },
  BILLS: { sf: "bolt.fill", md: "bolt" },
  SHOPS: { sf: "bag.fill", md: "shopping_bag" },
};

export const CATEGORIES: readonly RecipientCategory[] = [
  "PEOPLE",
  "TUITION",
  "RENT",
  "BILLS",
  "SHOPS",
];

/** A row of tappable chips (more than the 4 segments a segmented control allows). */
export function ChipRow<T extends string>({
  options,
  value,
  onChange,
  testIDPrefix,
}: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  testIDPrefix?: string;
}) {
  const { colors } = useTheme();
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ gap: 8, paddingVertical: 2 }}
    >
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <Pressable
            key={o.value}
            onPress={() => onChange(o.value)}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            testID={testIDPrefix ? `${testIDPrefix}-${o.value}` : undefined}
            style={{
              minHeight: 36,
              justifyContent: "center",
              paddingHorizontal: 14,
              borderRadius: 18,
              borderWidth: 1,
              borderColor: selected ? colors.brandAccent : colors.border,
              backgroundColor: selected ? colors.muted : colors.card,
            }}
          >
            <Text weight={selected ? "semibold" : undefined}>{o.label}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

/** "What are you paying?": one large tile per category. */
export function CategoryTiles({ onPick }: { onPick: (c: RecipientCategory) => void }) {
  const t = useKassaT();
  const { colors } = useTheme();
  return (
    <Box gap={2}>
      {CATEGORIES.map((c) => (
        <Pressable
          key={c}
          onPress={() => onPick(c)}
          accessibilityRole="button"
          testID={`recipient-category-${c}`}
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 12,
            minHeight: 60,
            padding: 14,
            borderRadius: 14,
            borderWidth: 1,
            borderColor: colors.border,
            backgroundColor: colors.card,
          }}
        >
          <Icon
            name={CATEGORY_ICON[c].sf}
            fallback={CATEGORY_ICON[c].md}
            size={24}
            color="brandAccent"
          />
          <View style={{ flex: 1, gap: 2 }}>
            <Text weight="semibold">{t(`payees:category.${c}`)}</Text>
            <Text variant="caption">{t(`payees:categoryHint.${c}`)}</Text>
          </View>
          <Icon name="chevron.right" fallback="chevron_right" size={18} color="mutedForeground" />
        </Pressable>
      ))}
    </Box>
  );
}

/** The editable form of a category's details: every field a string, as typed. */
export type DetailsForm = {
  relationship: Relationship;
  note: string;
  purposeCode: string;
  studentId: string;
  portalUrl: string;
  term: string;
  reference: string;
  dueDay: string;
  billType: BillType;
  customerNumber: string;
};

export const EMPTY_DETAILS: DetailsForm = {
  relationship: "FAMILY",
  note: "",
  purposeCode: "",
  studentId: "",
  portalUrl: "",
  term: "",
  reference: "",
  dueDay: "",
  billType: "UTILITIES",
  customerNumber: "",
};

export function detailsToForm(d: RecipientDetails | null): DetailsForm {
  if (!d) return EMPTY_DETAILS;
  switch (d.category) {
    case "PEOPLE":
      return {
        ...EMPTY_DETAILS,
        relationship: d.relationship,
        note: d.note ?? "",
        purposeCode: d.purposeCode ?? "",
      };
    case "TUITION":
      return {
        ...EMPTY_DETAILS,
        studentId: d.studentId,
        portalUrl: d.portalUrl ?? "",
        term: d.term ?? "",
      };
    case "RENT":
      return {
        ...EMPTY_DETAILS,
        reference: d.reference ?? "",
        dueDay: d.dueDay ? String(d.dueDay) : "",
      };
    case "BILLS":
      return {
        ...EMPTY_DETAILS,
        billType: d.billType,
        customerNumber: d.customerNumber,
        reference: d.reference ?? "",
      };
    case "SHOPS":
      return { ...EMPTY_DETAILS, note: d.note ?? "" };
  }
}

const opt = (s: string) => (s.trim() ? s.trim() : undefined);

/** Builds and checks the details (the server runs the same schema). `field` names the input to mark. */
export function formToDetails(
  category: RecipientCategory,
  f: DetailsForm
): { ok: true; details: RecipientDetails } | { ok: false; field: keyof DetailsForm; code: string } {
  if (category === "TUITION" && !f.studentId.trim())
    return { ok: false, field: "studentId", code: "DETAILS_MISSING" };
  if (category === "BILLS" && !f.customerNumber.trim())
    return { ok: false, field: "customerNumber", code: "DETAILS_MISSING" };
  if (category === "PEOPLE" && f.purposeCode.trim() && !/^\d{3}$/.test(f.purposeCode.trim())) {
    return { ok: false, field: "purposeCode", code: "KNP_INVALID" };
  }
  if (
    category === "TUITION" &&
    f.portalUrl.trim() &&
    !/^https:\/\/\S+\.\S+/i.test(f.portalUrl.trim())
  ) {
    return { ok: false, field: "portalUrl", code: "URL_INVALID" };
  }
  const dueDay = Number(f.dueDay);
  const raw =
    category === "PEOPLE"
      ? {
          category,
          relationship: f.relationship,
          note: opt(f.note),
          purposeCode: opt(f.purposeCode),
        }
      : category === "TUITION"
        ? {
            category,
            studentId: f.studentId.trim(),
            portalUrl: opt(f.portalUrl),
            term: opt(f.term),
          }
        : category === "RENT"
          ? { category, reference: opt(f.reference), dueDay: f.dueDay.trim() ? dueDay : undefined }
          : category === "BILLS"
            ? {
                category,
                billType: f.billType,
                customerNumber: f.customerNumber.trim(),
                reference: opt(f.reference),
              }
            : { category, note: opt(f.note) };
  const parsed = RecipientDetails.safeParse(JSON.parse(JSON.stringify(raw)));
  if (!parsed.success) {
    const path = parsed.error.issues[0]?.path[0];
    return {
      ok: false,
      field: (typeof path === "string" ? path : "note") as keyof DetailsForm,
      code: "DETAILS_MISSING",
    };
  }
  return { ok: true, details: parsed.data };
}

/** The inputs a category asks for. */
export function RecipientDetailsFields({
  category,
  form,
  onChange,
  errorFor,
}: {
  category: RecipientCategory;
  form: DetailsForm;
  onChange: (patch: Partial<DetailsForm>) => void;
  errorFor: (field: keyof DetailsForm) => string | undefined;
}) {
  const t = useKassaT();
  const hint = (key: string) => <Text variant="caption">{t(`payees:details.${key}`)}</Text>;

  if (category === "PEOPLE") {
    return (
      <Box gap={3}>
        <View style={{ marginHorizontal: -16 }}>
          <SettingPicker
            label={t("payees:details.relationship")}
            value={form.relationship}
            options={Relationship.options.map((r) => ({
              value: r,
              label: t(`payees:relationship.${r}`),
            }))}
            onChange={(r) => onChange({ relationship: r })}
            testID="recipient-relationship"
          />
        </View>
        <Input
          label={t("payees:details.note")}
          value={form.note}
          onChangeText={(v) => onChange({ note: v })}
          placeholder={t("payees:details.notePlaceholder")}
          error={errorFor("note")}
        />
        <Box gap={1}>
          <Input
            label={t("payees:details.purposeCode")}
            value={form.purposeCode}
            onChangeText={(v) => onChange({ purposeCode: v })}
            keyboardType="number-pad"
            maxLength={3}
            placeholder={form.relationship === "EMPLOYEE" ? "311" : "119"}
            error={errorFor("purposeCode")}
          />
          {hint("purposeCodeHint")}
        </Box>
      </Box>
    );
  }
  if (category === "TUITION") {
    return (
      <Box gap={3}>
        <Box gap={1}>
          <Input
            label={t("payees:details.studentId")}
            value={form.studentId}
            onChangeText={(v) => onChange({ studentId: v })}
            autoCapitalize="characters"
            error={errorFor("studentId")}
            testID="recipient-student-id"
          />
          {hint("studentIdHint")}
        </Box>
        <Box gap={1}>
          <Input
            label={t("payees:details.portalUrl")}
            value={form.portalUrl}
            onChangeText={(v) => onChange({ portalUrl: v })}
            autoCapitalize="none"
            keyboardType="url"
            placeholder="https://"
            error={errorFor("portalUrl")}
          />
          {hint("portalUrlHint")}
        </Box>
        <Input
          label={t("payees:details.term")}
          value={form.term}
          onChangeText={(v) => onChange({ term: v })}
          placeholder={t("payees:details.termPlaceholder")}
          error={errorFor("term")}
        />
      </Box>
    );
  }
  if (category === "RENT") {
    return (
      <Box gap={3}>
        <Box gap={1}>
          <Input
            label={t("payees:details.rentReference")}
            value={form.reference}
            onChangeText={(v) => onChange({ reference: v })}
            error={errorFor("reference")}
          />
          {hint("rentReferenceHint")}
        </Box>
        <Box gap={1}>
          <Input
            label={t("payees:details.dueDay")}
            value={form.dueDay}
            onChangeText={(v) => onChange({ dueDay: v.replace(/\D/g, "") })}
            keyboardType="number-pad"
            maxLength={2}
            error={errorFor("dueDay")}
          />
          {hint("dueDayHint")}
        </Box>
      </Box>
    );
  }
  if (category === "BILLS") {
    return (
      <Box gap={3}>
        <View style={{ marginHorizontal: -16 }}>
          <SettingPicker
            label={t("payees:details.billType")}
            value={form.billType}
            options={BillType.options.map((b) => ({ value: b, label: t(`payees:billType.${b}`) }))}
            onChange={(b) => onChange({ billType: b })}
            testID="recipient-bill-type"
          />
        </View>
        <Box gap={1}>
          <Input
            label={t("payees:details.customerNumber")}
            value={form.customerNumber}
            onChangeText={(v) => onChange({ customerNumber: v })}
            autoCapitalize="characters"
            error={errorFor("customerNumber")}
            testID="recipient-customer-number"
          />
          {hint("customerNumberHint")}
        </Box>
        <Input
          label={t("payees:details.billReference")}
          value={form.reference}
          onChangeText={(v) => onChange({ reference: v })}
          error={errorFor("reference")}
        />
      </Box>
    );
  }
  return (
    <Input
      label={t("payees:details.shopNote")}
      value={form.note}
      onChangeText={(v) => onChange({ note: v })}
      error={errorFor("note")}
    />
  );
}
