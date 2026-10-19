import { suggestedReference, type PayeeDto, type RecipientCategory } from "@kassa/shared";
import { type Href, Link, router, Stack, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { usePayees } from "@/api/hooks/payees";
import { RowGroup } from "@/components/row-group";
import { PayeeStatusChip } from "@/components/kassa/payee-status";
import { QueryView } from "@/components/kassa/query-view";
import { ScrollScreen } from "@/components/kassa/scroll-screen";
import { Box, Card, Icon, Text } from "@/components/ui";
import { useKassaT } from "@/lib/i18n";

import { CATEGORIES, CATEGORY_ICON, ChipRow } from "./recipient-fields";

type Filter = RecipientCategory | "ALL";

function PayeeRow({ payee, replaced }: { payee: PayeeDto; replaced: PayeeDto | undefined }) {
  const t = useKassaT();
  return (
    <Link href={`/payees/${payee.id}`} asChild>
      <Link.Trigger>
        <Pressable
          accessibilityRole="link"
          style={{ paddingHorizontal: 16, paddingVertical: 12, gap: 6, minHeight: 44 }}
        >
          <Box row justify="between" align="center" gap={2}>
            <Box row align="center" gap={2} style={{ flexShrink: 1 }}>
              <Icon
                name={CATEGORY_ICON[payee.category].sf}
                fallback={CATEGORY_ICON[payee.category].md}
                size={18}
                color="mutedForeground"
              />
              <Text weight="semibold" numberOfLines={1} style={{ flexShrink: 1 }}>
                {payee.name}
              </Text>
            </Box>
            <PayeeStatusChip payee={payee} />
          </Box>
          {suggestedReference(payee.details) ? (
            <Text variant="caption" numberOfLines={1}>
              {suggestedReference(payee.details)}
            </Text>
          ) : null}
          <Text variant="caption">
            {t("payees:meta", {
              kind: t(`payees:category.${payee.category}`),
              account: payee.accountMissing ? t("payees:accountNotAdded") : payee.accountMasked,
              currency: payee.currency,
              country: payee.country,
            })}
          </Text>
          {replaced ? (
            <Box row gap={2} align="center">
              <Icon
                name="arrow.triangle.branch"
                fallback="call_split"
                size={16}
                color="mutedForeground"
              />
              <Text variant="caption" style={{ flexShrink: 1 }}>
                {t("payees:replaces", { name: replaced.name, account: replaced.accountMasked })}
              </Text>
            </Box>
          ) : null}
        </Pressable>
      </Link.Trigger>
    </Link>
  );
}

/**
 * Recipients (spec §16 "payees"): grouped by what you pay (people, tuition, rent, bills, shops), with status chips and
 * the cooling countdown; "a changed account is a new recipient" (I7).
 */
export function PayeesScreen() {
  const t = useKassaT();
  const payees = usePayees();
  const params = useLocalSearchParams<{ category?: string }>();
  const [filter, setFilter] = useState<Filter>(
    CATEGORIES.includes(params.category as RecipientCategory)
      ? (params.category as RecipientCategory)
      : "ALL"
  );

  return (
    <>
      <Stack.Screen
        options={{
          headerRight: () => (
            <Pressable
              onPress={() =>
                router.push(
                  (filter === "ALL" ? "/payees/new" : `/payees/new?category=${filter}`) as Href
                )
              }
              accessibilityRole="button"
              accessibilityLabel={t("payees:add.title")}
              style={{
                minWidth: 44,
                minHeight: 44,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Icon name="plus" fallback="add" size={22} />
            </Pressable>
          ),
        }}
      />
      <ScrollScreen onRefresh={() => void payees.refetch()} refreshing={payees.isRefetching}>
        <Card>
          <Box row gap={3}>
            <Icon name="shield.lefthalf.filled" fallback="shield" size={22} color="brandAccent" />
            <Box flex={1} gap={1}>
              <Text weight="semibold">{t("payees:explainerTitle")}</Text>
              <Text variant="caption">{t("payees:explainerBody")}</Text>
            </Box>
          </Box>
        </Card>
        <QueryView
          query={payees}
          isEmpty={(p) => p.payees.length === 0}
          empty={<Text variant="caption">{t("payees:empty")}</Text>}
        >
          {(p) => {
            const byId = new Map(p.payees.map((x) => [x.id, x]));
            const count = (c: Filter) =>
              c === "ALL" ? p.payees.length : p.payees.filter((x) => x.category === c).length;
            const shown =
              filter === "ALL" ? p.payees : p.payees.filter((x) => x.category === filter);
            const chips = (["ALL", ...CATEGORIES] as Filter[]).map((c) => ({
              value: c,
              label: `${t(`payees:category.${c}`)} ${count(c)}`,
            }));
            return (
              <Box gap={3}>
                <ChipRow
                  options={chips}
                  value={filter}
                  onChange={setFilter}
                  testIDPrefix="recipient-filter"
                />
                {shown.length === 0 ? (
                  <Text variant="caption">
                    {t("payees:emptyCategory", { category: t(`payees:category.${filter}`) })}
                  </Text>
                ) : null}
                <RowGroup>
                  {shown.map((payee) => (
                    <View key={payee.id}>
                      <PayeeRow
                        payee={payee}
                        replaced={
                          payee.replacesPayeeId ? byId.get(payee.replacesPayeeId) : undefined
                        }
                      />
                    </View>
                  ))}
                </RowGroup>
              </Box>
            );
          }}
        </QueryView>
      </ScrollScreen>
    </>
  );
}
