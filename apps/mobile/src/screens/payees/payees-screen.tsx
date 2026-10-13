import type { PayeeDto } from "@kassa/shared";
import { Link, Stack } from "expo-router";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { usePayees } from "@/api/hooks/payees";
import { RowGroup } from "@/components/row-group";
import { PayeeStatusChip } from "@/components/kassa/payee-status";
import { QueryView } from "@/components/kassa/query-view";
import { ScrollScreen } from "@/components/kassa/scroll-screen";
import { Box, Card, Icon, Text } from "@/components/ui";
import { useKassaT } from "@/lib/i18n";

import { AddPayeeSheet } from "./add-payee-sheet";

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
            <Text weight="semibold" numberOfLines={1} style={{ flexShrink: 1 }}>
              {payee.name}
            </Text>
            <PayeeStatusChip payee={payee} />
          </Box>
          <Text variant="caption">
            {t("payees:meta", {
              kind: t(`payees:kind.${payee.kind}`),
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

/** Payees (spec §16): status chips with countdown; "a changed account is a new payee" (I7). */
export function PayeesScreen() {
  const t = useKassaT();
  const payees = usePayees();
  const [adding, setAdding] = useState(false);

  return (
    <>
      <Stack.Screen
        options={{
          headerRight: () => (
            <Pressable
              onPress={() => setAdding(true)}
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
            return (
              <RowGroup>
                {p.payees.map((payee) => (
                  <View key={payee.id}>
                    <PayeeRow
                      payee={payee}
                      replaced={payee.replacesPayeeId ? byId.get(payee.replacesPayeeId) : undefined}
                    />
                  </View>
                ))}
              </RowGroup>
            );
          }}
        </QueryView>
      </ScrollScreen>
      <AddPayeeSheet visible={adding} onClose={() => setAdding(false)} />
    </>
  );
}
