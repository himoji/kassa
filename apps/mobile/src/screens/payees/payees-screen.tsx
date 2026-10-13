import { CurrencyCode, PayeeKind, type PayeeDto } from "@kassa/shared";
import { Link, Stack } from "expo-router";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { useCreatePayee, usePayees } from "@/api/hooks/payees";
import { RowGroup } from "@/components/row-group";
import { errorText } from "@/components/kassa/error-text";
import { SettingPicker } from "@/components/kassa/native-controls";
import { PayeeStatusChip } from "@/components/kassa/payee-status";
import { QueryView } from "@/components/kassa/query-view";
import { ScrollScreen } from "@/components/kassa/scroll-screen";
import { Box, Button, Card, Icon, Input, Sheet, Text, toast } from "@/components/ui";
import { copyToClipboard } from "@/lib/clipboard";
import { currencyCodes } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { useKassaT } from "@/lib/i18n";

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
      {payee.accountMissing ? null : (
        <Link.Menu>
          <Link.MenuAction
            title={t("payees:copyAccount")}
            icon="doc.on.doc"
            onPress={() => void copyToClipboard(payee.accountMasked, { toast: t("payees:copied") })}
          />
        </Link.Menu>
      )}
    </Link>
  );
}

function AddPayeeSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const t = useKassaT();
  const create = useCreatePayee();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<PayeeKind>("PERSON");
  const [account, setAccount] = useState("");
  const [country, setCountry] = useState("HU");
  const [currency, setCurrency] = useState<string>("HUF");
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    // ISO 3166-1 alpha-2 country, ISO 4217 currency (validated again by the server).
    const cc = country.trim().toUpperCase();
    if (
      !name.trim() ||
      account.trim().length < 4 ||
      !/^[A-Z]{2}$/.test(cc) ||
      !CurrencyCode.safeParse(currency).success
    ) {
      setError(t("payees:add.invalid"));
      return;
    }
    try {
      await create.mutateAsync({
        name: name.trim(),
        kind,
        account: account.replace(/\s+/g, ""),
        country: cc,
        currency,
      });
      haptics.success();
      toast.show({ title: t("payees:add.created"), description: t("payees:add.coolingNote") });
      onClose();
    } catch (err) {
      haptics.error();
      setError(errorText(t, err));
    }
  };

  return (
    <Sheet visible={visible} onClose={onClose} detents={["full"]}>
      <Box p={5} gap={4}>
        <Text variant="heading">{t("payees:add.title")}</Text>
        <Text variant="caption">{t("payees:add.coolingNote")}</Text>
        <Input
          label={t("payees:add.name")}
          value={name}
          onChangeText={setName}
          autoCapitalize="words"
        />
        <SettingPicker
          label={t("payees:add.kind")}
          value={kind}
          options={PayeeKind.options.map((k) => ({ value: k, label: t(`payees:kind.${k}`) }))}
          onChange={setKind}
        />
        <Input
          label={t("payees:add.account")}
          value={account}
          onChangeText={setAccount}
          autoCapitalize="characters"
        />
        <Input
          label={t("payees:add.country")}
          value={country}
          onChangeText={setCountry}
          autoCapitalize="characters"
        />
        <SettingPicker
          label={t("payees:add.currency")}
          value={currency}
          options={currencyCodes().map((c) => ({ value: c, label: c }))}
          onChange={setCurrency}
        />
        {error ? <Text color="destructive">{error}</Text> : null}
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
