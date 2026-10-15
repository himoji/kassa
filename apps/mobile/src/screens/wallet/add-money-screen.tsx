import { toMinor, type TopUpMethod, type TopUpResponse } from "@kassa/shared";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Animated, Modal, Platform, Pressable, View } from "react-native";

import { KassaApiError } from "@/api/errors";
import { useFundingSources } from "@/api/hooks/funding-sources";
import { useTopUp, useWallet } from "@/api/hooks/wallet";
import { SimulatedBadge } from "@/components/kassa/badges";
import { errorText } from "@/components/kassa/error-text";
import { MoneyInput } from "@/components/kassa/money-input";
import { QueryView } from "@/components/kassa/query-view";
import { ScrollScreen } from "@/components/kassa/scroll-screen";
import { Segmented } from "@/components/kassa/segmented";
import { RowGroup } from "@/components/row-group";
import { Box, Button, Card, Icon, Row, Text, useTheme } from "@/components/ui";
import { useFormat } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { useKassaT } from "@/lib/i18n";
import { uuidv4 } from "@/lib/uuid";

import { sourceIcon } from "./linked-accounts-screen";

/** Currencies offered for a top-up: the ones the demo's corridors use. */
const TOP_UP_CURRENCIES = ["EUR", "KZT", "CNY", "USD"] as const;
const QUICK_AMOUNTS: Record<string, number[]> = {
  EUR: [20, 50, 100],
  USD: [20, 50, 100],
  CNY: [100, 300, 800],
  KZT: [10_000, 25_000, 50_000],
};

function defaultMethod(): TopUpMethod {
  return Platform.OS === "android" ? "GOOGLE_PAY" : "APPLE_PAY";
}

type SheetPhase = "confirm" | "processing" | "done";

/**
 * A stand-in for the system wallet sheet (Apple Pay / Google Pay / Samsung Pay). It never touches a real wallet or
 * card: confirming calls POST /wallet/top-ups, which charges a Stripe test card or nothing at all.
 */
function WalletSheet({
  visible,
  method,
  amountLabel,
  phase,
  onConfirm,
  onCancel,
}: {
  visible: boolean;
  method: TopUpMethod;
  amountLabel: string;
  phase: SheetPhase;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useKassaT();
  const [pulse] = useState(() => new Animated.Value(1));
  useEffect(() => {
    if (!visible || phase !== "confirm") return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1.12, duration: 600, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 600, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [visible, phase, pulse]);

  const dark = method === "APPLE_PAY" || method === "SAMSUNG_PAY";
  const bg = dark ? "#1c1c1e" : "#ffffff";
  const fg = dark ? "#ffffff" : "#202124";
  const sub = dark ? "#a1a1a6" : "#5f6368";
  const line = dark ? "#38383a" : "#e8eaed";
  const biometric =
    method === "APPLE_PAY" ? t("wallet:sheet.faceId") : t("wallet:sheet.fingerprint");

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onCancel}>
      <View style={{ flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.45)" }}>
        <View
          testID="wallet-sheet"
          style={{
            backgroundColor: bg,
            borderTopLeftRadius: 20,
            borderTopRightRadius: 20,
            padding: 20,
            paddingBottom: 36,
            gap: 16,
            width: "100%",
            maxWidth: 520,
            alignSelf: "center",
          }}
        >
          <View
            style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Text weight="semibold" style={{ color: fg, fontSize: 20 }}>
                {t(`wallet:methods.${method}`)}
              </Text>
              <View
                style={{
                  backgroundColor: "#ff9f0a",
                  borderRadius: 4,
                  paddingHorizontal: 6,
                  paddingVertical: 1,
                }}
              >
                <Text weight="semibold" style={{ color: "#000", fontSize: 11 }}>
                  {t("wallet:sheet.test")}
                </Text>
              </View>
            </View>
            {phase === "confirm" ? (
              <Pressable onPress={onCancel} accessibilityRole="button" hitSlop={12}>
                <Text style={{ color: "#0a84ff" }}>{t("wallet:sheet.cancel")}</Text>
              </Pressable>
            ) : null}
          </View>

          <View style={{ borderTopWidth: 1, borderColor: line, paddingTop: 12, gap: 4 }}>
            <Text style={{ color: sub, fontSize: 13 }}>{t("wallet:sheet.merchant")}</Text>
            <Text style={{ color: fg }}>{t("wallet:sheet.card")}</Text>
          </View>
          <View
            style={{
              borderTopWidth: 1,
              borderBottomWidth: 1,
              borderColor: line,
              paddingVertical: 12,
              flexDirection: "row",
              justifyContent: "space-between",
            }}
          >
            <Text style={{ color: sub }}>{t("wallet:sheet.total")}</Text>
            <Text weight="semibold" style={{ color: fg, fontVariant: ["tabular-nums"] }}>
              {amountLabel}
            </Text>
          </View>

          <View style={{ alignItems: "center", gap: 10, minHeight: 120, justifyContent: "center" }}>
            {phase === "confirm" ? (
              <Pressable
                testID="wallet-sheet-confirm"
                onPress={onConfirm}
                accessibilityRole="button"
                accessibilityLabel={biometric}
                style={{ alignItems: "center", gap: 10 }}
              >
                <Animated.View style={{ transform: [{ scale: pulse }] }}>
                  <Icon
                    name={method === "APPLE_PAY" ? "faceid" : "touchid"}
                    fallback={method === "APPLE_PAY" ? "face" : "fingerprint"}
                    size={56}
                    color="brandAccent"
                  />
                </Animated.View>
                <Text style={{ color: fg }}>{biometric}</Text>
                <Text style={{ color: "#0a84ff", fontSize: 13 }}>{t("wallet:sheet.confirm")}</Text>
              </Pressable>
            ) : phase === "processing" ? (
              <>
                <ActivityIndicator color={fg} />
                <Text style={{ color: sub }}>{t("wallet:sheet.processing")}</Text>
              </>
            ) : (
              <>
                <Icon
                  name="checkmark.circle.fill"
                  fallback="check-circle"
                  size={56}
                  color="success"
                />
                <Text style={{ color: fg }}>{t("wallet:sheet.done")}</Text>
              </>
            )}
          </View>
        </View>
      </View>
    </Modal>
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function AddMoneyScreen() {
  const t = useKassaT();
  const f = useFormat();
  const { colors } = useTheme();
  const params = useLocalSearchParams<{ currency?: string }>();
  const wallet = useWallet();
  const topUp = useTopUp();
  const [currency, setCurrency] = useState<string>(
    TOP_UP_CURRENCIES.includes(params.currency as never) ? params.currency! : "EUR"
  );
  const [amountMinor, setAmountMinor] = useState<number | null>(() =>
    toMinor(String(QUICK_AMOUNTS[currency]![1]), currency)
  );
  const [method, setMethod] = useState<TopUpMethod>(defaultMethod);
  // (linked accounts) Add from a linked card or bank instead of a wallet tap.
  const sources = useFundingSources();
  const linkable = (sources.data?.sources ?? []).filter(
    (s) => s.status === "ACTIVE" && TOP_UP_CURRENCIES.includes(s.currency as never)
  );
  const [linkedId, setLinkedId] = useState<string | null>(null);
  const linked = linkable.find((s) => s.id === linkedId) ?? null;
  const [phase, setPhase] = useState<SheetPhase | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TopUpResponse | null>(null);
  // One key per attempt: a double tap or a retry of the same attempt never adds twice.
  const attemptKey = useRef(uuidv4());

  const amountLabel = amountMinor ? f.money(amountMinor, currency) : "";

  const start = () => {
    setError(null);
    if (!amountMinor) {
      setError(t("wallet:errors.AMOUNT"));
      haptics.error();
      return;
    }
    haptics.selection();
    // A linked account needs no wallet sheet: it was confirmed with the passkey when it was linked.
    if (linked) return void confirm();
    setPhase("confirm");
  };

  const confirm = async () => {
    setPhase(linked ? null : "processing");
    try {
      const [res] = await Promise.all([
        topUp.mutateAsync({
          amountMinor: amountMinor!,
          currency,
          method: linked ? "LINKED" : method,
          ...(linked ? { fundingSourceId: linked.id } : {}),
          idempotencyKey: attemptKey.current,
        }),
        sleep(linked ? 0 : 900),
      ]);
      if (linked) {
        haptics.success();
        setResult(res);
        attemptKey.current = uuidv4();
        return;
      }
      setPhase("done");
      haptics.success();
      await sleep(700);
      setPhase(null);
      setResult(res);
      attemptKey.current = uuidv4();
    } catch (err) {
      setPhase(null);
      haptics.error();
      const code = err instanceof KassaApiError ? err.code : null;
      const known = code ? t(`wallet:errors.${code}`, { defaultValue: "" }) : "";
      setError(known || errorText(t, err));
    }
  };

  if (result) {
    return (
      <ScrollScreen testID="add-money-done">
        <Card>
          <Box gap={3} style={{ alignItems: "center", paddingVertical: 12 }}>
            <Icon name="checkmark.circle.fill" fallback="check-circle" size={56} color="success" />
            <Text variant="title">
              {t("wallet:added", { amount: f.money(result.amountMinor, result.currency) })}
            </Text>
            <Text variant="caption" style={{ textAlign: "center" }}>
              {t("wallet:addedBody")}
            </Text>
            {result.balanceAfterMinor !== null ? (
              <Text weight="semibold">
                {t("wallet:balanceNow", {
                  currency: result.currency,
                  amount: f.money(result.balanceAfterMinor, result.currency),
                })}
              </Text>
            ) : null}
            <SimulatedBadge />
          </Box>
        </Card>
        <Box gap={2}>
          <Button size="lg" onPress={() => router.replace("/send")}>
            {t("wallet:sendNow")}
          </Button>
          <Button variant="secondary" onPress={() => setResult(null)}>
            {t("wallet:addMore")}
          </Button>
          <Button
            variant="ghost"
            onPress={() => (router.canGoBack() ? router.back() : router.replace("/home"))}
          >
            {t("wallet:done")}
          </Button>
        </Box>
      </ScrollScreen>
    );
  }

  return (
    <ScrollScreen testID="add-money">
      <QueryView query={wallet} skeletonRows={3}>
        {(w) =>
          !w.canTopUp ? (
            <Card>
              <Box gap={3}>
                <Text>{t("wallet:needsWallet")}</Text>
                <Button variant="secondary" onPress={() => router.push("/settings")}>
                  {t("wallet:openSettings")}
                </Button>
              </Box>
            </Card>
          ) : (
            <>
              <Card>
                <Box gap={2}>
                  <Box row justify="between" align="center">
                    <Text variant="label">{t("wallet:addTitle")}</Text>
                    <SimulatedBadge />
                  </Box>
                  <Text variant="caption">{t("wallet:testMode")}</Text>
                </Box>
              </Card>

              <Box gap={2}>
                <Text variant="label">{t("wallet:currency")}</Text>
                <Segmented
                  value={currency}
                  onChange={(c) => {
                    if (linked && linked.currency !== c) setLinkedId(null);
                    setCurrency(c);
                    setAmountMinor(toMinor(String(QUICK_AMOUNTS[c]![1]), c));
                  }}
                  options={TOP_UP_CURRENCIES.map((c) => ({ value: c, label: c }))}
                />
              </Box>

              <Box gap={2}>
                <Text variant="label">{t("wallet:amount")}</Text>
                <MoneyInput
                  testID="top-up-amount"
                  valueMinor={amountMinor}
                  currency={currency}
                  onChange={setAmountMinor}
                  accessibilityLabel={t("wallet:amountA11y")}
                />
                <Box row gap={2}>
                  {QUICK_AMOUNTS[currency]!.map((a) => (
                    <Button
                      key={a}
                      size="sm"
                      variant={amountMinor === toMinor(String(a), currency) ? "primary" : "outline"}
                      onPress={() => setAmountMinor(toMinor(String(a), currency))}
                    >
                      {f.money(toMinor(String(a), currency), currency)}
                    </Button>
                  ))}
                </Box>
                <Text variant="caption">
                  {t("wallet:todayLimit", {
                    used: f.money(w.topUpTodayHomeMinor, w.homeCurrency),
                    limit: f.money(w.topUpDailyLimitHomeMinor, w.homeCurrency),
                  })}
                </Text>
              </Box>

              <Box gap={2}>
                <Text variant="label">{t("wallet:method")}</Text>
                <Segmented
                  value={linked ? ("" as TopUpMethod) : method}
                  onChange={(m) => {
                    setLinkedId(null);
                    setMethod(m);
                  }}
                  options={(["APPLE_PAY", "GOOGLE_PAY", "SAMSUNG_PAY", "CARD"] as const).map(
                    (m) => ({
                      value: m,
                      label: t(`wallet:methods.${m}`),
                    })
                  )}
                />
              </Box>

              {linkable.length > 0 ? (
                <RowGroup title={t("wallet:fromLinked")} icons>
                  {linkable.map((s) => {
                    const icon = sourceIcon(s);
                    return (
                      <Row
                        key={s.id}
                        testID={`top-up-from-${s.id}`}
                        leading={
                          <Icon
                            name={icon.name}
                            fallback={icon.fallback}
                            size={20}
                            color="brandAccent"
                          />
                        }
                        title={s.label}
                        subtitle={s.currency}
                        onPress={() => {
                          haptics.selection();
                          setLinkedId(s.id);
                          if (s.currency !== currency) {
                            setCurrency(s.currency);
                            setAmountMinor(
                              toMinor(String(QUICK_AMOUNTS[s.currency]![1]), s.currency)
                            );
                          }
                        }}
                        trailing={
                          s.id === linkedId ? (
                            <Icon name="checkmark" fallback="check" size={20} color="brandAccent" />
                          ) : undefined
                        }
                      />
                    );
                  })}
                </RowGroup>
              ) : null}

              {error ? <Text color="destructive">{error}</Text> : null}

              <Pressable
                testID="wallet-pay-button"
                onPress={start}
                accessibilityRole="button"
                style={({ pressed }) => ({
                  height: 52,
                  borderRadius: 12,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: method === "GOOGLE_PAY" ? colors.foreground : "#000000",
                  opacity: pressed ? 0.8 : 1,
                })}
              >
                <Text
                  weight="semibold"
                  style={{
                    color: method === "GOOGLE_PAY" ? colors.background : "#ffffff",
                    fontSize: 17,
                  }}
                >
                  {linked
                    ? t("wallet:addFrom", { label: linked.label })
                    : t("wallet:payButton", { method: t(`wallet:methods.${method}`) })}
                  {amountLabel ? ` · ${amountLabel}` : ""}
                </Text>
              </Pressable>
            </>
          )
        }
      </QueryView>
      <WalletSheet
        visible={phase !== null}
        method={method}
        amountLabel={amountLabel}
        phase={phase ?? "confirm"}
        onConfirm={() => void confirm()}
        onCancel={() => setPhase(null)}
      />
    </ScrollScreen>
  );
}
