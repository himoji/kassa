import { router } from "expo-router";

import { useRecoveryCodesStatus } from "@/api/hooks/auth";
import { useMe } from "@/api/hooks/me";
import { useBudgets } from "@/api/hooks/money";
import { useMandates } from "@/api/hooks/payees";
import { useCaps, useEraseAccount, usePendingRuleChanges } from "@/api/hooks/settings";
import { useWallet } from "@/api/hooks/wallet";
import { RowGroup } from "@/components/row-group";
import { ScrollScreen } from "@/components/kassa/scroll-screen";
import { Box, Icon, Row, Text, toast, useThemeMode } from "@/components/ui";
import { auth } from "@/lib/auth";
import { copyToClipboard } from "@/lib/clipboard";
import { confirm } from "@/lib/confirm";
import { useFormat } from "@/lib/format";
import { LANGUAGE_LABELS, useKassaT, useLanguagePreference } from "@/lib/i18n";

import { PendingChanges } from "./pending-changes";

/** A row's short trailing value ("Smart", "1 active"), muted like the Settings app. */
function Value({ children, testID }: { children?: string; testID?: string }) {
  if (!children) return null;
  return (
    <Text
      variant="caption"
      color="mutedForeground"
      numberOfLines={1}
      testID={testID}
      style={{ fontVariant: ["tabular-nums"], flexShrink: 1, textAlign: "right" }}
    >
      {children}
    </Text>
  );
}

/**
 * Settings: a short grouped list, each row with its current value; the details (preset cards, limits, mandates,
 * budgets, backup codes, appearance, demo) open one tap away in app/(tabs)/settings/*.
 */
export function SettingsScreen() {
  const t = useKassaT();
  const f = useFormat();
  const me = useMe();
  const wallet = useWallet();
  const caps = useCaps();
  const mandates = useMandates();
  const budgets = useBudgets();
  const codes = useRecoveryCodesStatus();
  const pendingChanges = usePendingRuleChanges();
  const themeMode = useThemeMode();
  const language = useLanguagePreference();
  const erase = useEraseAccount();

  const kassaId = wallet.data?.kassaId;
  const settings = me.data?.settings;
  const customised = settings ? Object.values(settings.overrides).some((v) => v !== null) : false;
  const presetName = settings ? t(`settings:preset.${settings.preset}.title`) : undefined;
  const presetValue =
    presetName && customised
      ? t("settings:root.presetCustomised", { preset: presetName })
      : presetName;
  const c = caps.data?.caps;
  const limitsValue = c
    ? t("settings:root.limitsValue", { amount: f.money(c.perPaymentMinor, c.currency) })
    : undefined;
  const activeMandates = mandates.data?.mandates.filter((m) => m.status === "ACTIVE").length;
  const mandatesValue =
    activeMandates === undefined
      ? undefined
      : activeMandates === 0
        ? t("settings:root.none")
        : t("settings:root.mandatesActive", { count: activeMandates });
  const budgetCount = budgets.data?.budgets.length;
  const budgetsValue =
    budgetCount === undefined
      ? undefined
      : budgetCount === 0
        ? t("settings:root.none")
        : t("settings:root.budgetsCount", { count: budgetCount });
  const s = codes.data;
  const codesValue = s
    ? s.total > 0
      ? t("settings:root.backupLeft", { remaining: s.remaining, total: s.total })
      : t("settings:root.backupNone")
    : undefined;
  const languageValue =
    language === "system" ? t("settings:languageSystem") : LANGUAGE_LABELS[language];

  const refresh = () =>
    Promise.all([
      me.refetch(),
      wallet.refetch(),
      caps.refetch(),
      mandates.refetch(),
      budgets.refetch(),
      codes.refetch(),
      pendingChanges.refetch(),
    ]);

  const signOut = async () => {
    const ok = await confirm({
      title: t("settings:signOutTitle"),
      confirmLabel: t("settings:signOut"),
      cancelLabel: t("common:cancel"),
    });
    if (ok) await auth.signOut();
  };

  const deleteAccount = async () => {
    const ok = await confirm({
      title: t("settings:deleteAccount.title"),
      message: t("settings:deleteAccount.message"),
      confirmLabel: t("settings:deleteAccount.confirm"),
      cancelLabel: t("common:cancel"),
      destructive: true,
    });
    if (!ok) return;
    try {
      await erase.mutateAsync();
    } catch (e) {
      toast.show({
        title: t("settings:deleteAccount.failed", {
          message: e instanceof Error ? e.message : String(e),
        }),
      });
      return;
    }
    toast.show({ title: t("settings:deleteAccount.done"), kind: "success" });
    await auth.signOut();
  };

  return (
    <ScrollScreen onRefresh={refresh} testID="settings-screen">
      <RowGroup title={t("settings:root.accountTitle")} icons>
        <Row
          leading={
            <Icon
              name="person.crop.circle.fill"
              fallback="account_circle"
              size={22}
              color="brandAccent"
            />
          }
          title={t("wallet:kassaId")}
          trailing={
            kassaId ? (
              <Box row gap={2} align="center" style={{ flexShrink: 1 }}>
                <Text
                  weight="semibold"
                  selectable
                  numberOfLines={1}
                  testID="kassa-id"
                  style={{ fontVariant: ["tabular-nums"], letterSpacing: 1 }}
                >
                  {kassaId}
                </Text>
                <Icon name="doc.on.doc" fallback="content_copy" size={16} color="mutedForeground" />
              </Box>
            ) : undefined
          }
          chevron={false}
          onPress={
            kassaId
              ? () => void copyToClipboard(kassaId, { toast: t("wallet:kassaIdCopied") })
              : undefined
          }
          testID="settings-kassa-id"
        />
      </RowGroup>

      <PendingChanges />

      <RowGroup title={t("settings:root.howKassaPaysTitle")} icons>
        <Row
          leading={<Icon name="sparkles" fallback="auto_awesome" size={20} color="foreground" />}
          title={t("settings:presetTitle")}
          trailing={<Value testID="settings-preset-value">{presetValue}</Value>}
          chevron
          onPress={() => router.push("/settings/preset")}
          testID="settings-preset"
        />
        <Row
          leading={<Icon name="gauge.with.needle" fallback="speed" size={20} color="foreground" />}
          title={t("settings:capsTitle")}
          trailing={<Value>{limitsValue}</Value>}
          chevron
          onPress={() => router.push("/settings/limits")}
          testID="settings-limits"
        />
        <Row
          leading={<Icon name="signature" fallback="draw" size={20} color="foreground" />}
          title={t("settings:mandates.title")}
          trailing={<Value>{mandatesValue}</Value>}
          chevron
          onPress={() => router.push("/settings/mandates")}
          testID="settings-mandates"
        />
        <Row
          leading={<Icon name="chart.pie" fallback="pie_chart" size={20} color="foreground" />}
          title={t("settings:budgets.title")}
          trailing={<Value>{budgetsValue}</Value>}
          chevron
          onPress={() => router.push("/settings/budgets")}
          testID="settings-budgets"
        />
      </RowGroup>

      <RowGroup title={t("settings:root.securityTitle")} icons>
        <Row
          leading={<Icon name="key" fallback="key" size={20} color="foreground" />}
          title={t("settings:backupCodes.title")}
          trailing={<Value>{codesValue}</Value>}
          chevron
          onPress={() => router.push("/settings/security")}
          testID="settings-backup-codes"
        />
        <Row
          leading={
            <Icon name="person.text.rectangle" fallback="badge" size={20} color="foreground" />
          }
          title={t("kyc:title")}
          onPress={() => router.push("/identity-check")}
          testID="settings-identity-check"
        />
      </RowGroup>

      <RowGroup title={t("settings:root.appTitle")} icons>
        <Row
          leading={
            <Icon name="circle.lefthalf.filled" fallback="contrast" size={20} color="foreground" />
          }
          title={t("settings:appearanceTitle")}
          trailing={<Value>{t(`settings:theme.${themeMode}`)}</Value>}
          chevron
          onPress={() => router.push("/settings/appearance")}
          testID="settings-appearance"
        />
        <Row
          leading={<Icon name="globe" fallback="language" size={20} color="foreground" />}
          title={t("settings:languageLabel")}
          trailing={<Value>{languageValue}</Value>}
          chevron
          onPress={() => router.push("/settings/appearance")}
          testID="settings-language-row"
        />
      </RowGroup>

      <RowGroup title={t("settings:moreTitle")} icons>
        <Row
          leading={<Icon name="person.2" fallback="group" size={20} color="foreground" />}
          title={t("payees:title")}
          onPress={() => router.push("/payees")}
        />
        <Row
          leading={<Icon name="calendar" fallback="event" size={20} color="foreground" />}
          title={t("bills:title")}
          onPress={() => router.push("/bills")}
        />
        <Row
          leading={<Icon name="creditcard" fallback="credit_card" size={20} color="foreground" />}
          title={t("wallet:linked.title")}
          onPress={() => router.push("/linked-accounts")}
          testID="settings-linked-accounts"
        />
        <Row
          leading={
            <Icon
              name="arrow.up.arrow.down"
              fallback="import_export"
              size={20}
              color="foreground"
            />
          }
          title={t("settings:data.title")}
          onPress={() => router.push("/data")}
        />
        <Row
          leading={<Icon name="wave.3.right" fallback="contactless" size={20} color="foreground" />}
          title={t("shortcut:title")}
          onPress={() => router.push("/shortcut")}
        />
        <Row
          leading={
            <Icon
              name="iphone.and.arrow.forward"
              fallback="phonelink"
              size={20}
              color="foreground"
            />
          }
          title={t("lite:pairDevice.rowTitle")}
          onPress={() => router.push("/pair-lite")}
        />
        <Row
          leading={
            <Icon
              name="doc.text.magnifyingglass"
              fallback="description"
              size={20}
              color="foreground"
            />
          }
          title={t("credit:title")}
          onPress={() => router.push("/credit-record")}
        />
      </RowGroup>

      <RowGroup icons>
        <Row
          leading={
            <Icon name="checkmark.shield" fallback="verified_user" size={20} color="foreground" />
          }
          title={t("evidence:links.title")}
          subtitle={t("settings:root.demoProofHint")}
          onPress={() => router.push("/settings/demo-proof")}
          testID="settings-demo-proof"
        />
      </RowGroup>

      <RowGroup icons>
        <Row
          leading={
            <Icon
              name="rectangle.portrait.and.arrow.right"
              fallback="logout"
              size={20}
              color="destructive"
            />
          }
          title={t("settings:signOut")}
          destructive
          chevron={false}
          onPress={signOut}
          testID="settings-sign-out"
        />
        <Row
          leading={<Icon name="trash" fallback="delete" size={20} color="destructive" />}
          title={t("settings:deleteAccount.row")}
          subtitle={t("settings:deleteAccount.rowHint")}
          destructive
          chevron={false}
          testID="settings-delete-account"
          onPress={deleteAccount}
        />
      </RowGroup>
    </ScrollScreen>
  );
}
