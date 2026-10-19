import { router } from "expo-router";
import { useEffect, useState } from "react";

import { ScrollScreen } from "@/components/kassa/scroll-screen";
import { Segmented } from "@/components/kassa/segmented";
import { RowGroup } from "@/components/row-group";
import { Box, Button, Icon, Input, Row, Text, toast, useTheme } from "@/components/ui";
import { confirm } from "@/lib/confirm";
import { useKassaT } from "@/lib/i18n";
import { setDataMode, useDataMode, type DataMode } from "@/lite/data-mode";
import { syncIntentConfig } from "@/lite/intent-config";
import { loadDisplayName } from "@/lite/profile";
import {
  applyServerUrl,
  loadServerUrl,
  normalizeServerUrl,
  saveServerUrl,
} from "@/lite/server-url";
import { liteSignOut } from "@/lite/sign-out";

import { serverHost, useShortcutStatus, type ShortcutStatus } from "./shortcut-setup";
import { UpdatesSection } from "./updates-section";

/**
 * KassaLite settings: a short list, details one tap away (Apple Pay & Siri → /shortcut, Demo & proof → /demo);
 * pairing state, data shown, server URL and sign out stay inline.
 */
export function LiteSettingsScreen() {
  const t = useKassaT();
  const { colors } = useTheme();
  const dataMode = useDataMode();
  const shortcut = useShortcutStatus();
  const [name, setName] = useState<string | null>(null);
  const [server, setServer] = useState("");
  const [serverError, setServerError] = useState<string | null>(null);
  const [editServer, setEditServer] = useState(false);

  useEffect(() => {
    void loadDisplayName().then(setName);
    void loadServerUrl().then((s) => s && setServer(s));
  }, []);

  const saveServer = async () => {
    const normalized = normalizeServerUrl(server);
    if (!normalized) {
      setServerError(t("lite:settings.serverInvalid"));
      return;
    }
    setServerError(null);
    await saveServerUrl(normalized);
    applyServerUrl(normalized);
    void syncIntentConfig();
    setServer(normalized);
    setEditServer(false);
    toast.show({ title: t("lite:settings.serverSaved"), kind: "success" });
  };

  const signOut = async () => {
    const ok = await confirm({
      title: t("lite:settings.signOutTitle"),
      message: t("lite:settings.signOutBody"),
      confirmLabel: t("lite:settings.signOut"),
      cancelLabel: t("common:cancel"),
      destructive: true,
    });
    if (ok) await liteSignOut();
  };

  return (
    <ScrollScreen>
      <RowGroup title={t("lite:settings.accountTitle")} icons>
        <Row
          leading={
            <Icon
              name="person.crop.circle.fill"
              fallback="account_circle"
              size={26}
              color="brandAccent"
            />
          }
          title={t("lite:settings.signedInAs", { name: name ?? t("lite:settings.unknownUser") })}
          subtitle={server ? serverHost(server) : undefined}
        />
      </RowGroup>

      <RowGroup title={t("lite:settings.siriTitle")} icons>
        <Row
          leading={<Icon name="wave.3.right" fallback="contactless" size={20} color="foreground" />}
          title={t("lite:settings.shortcutTitle")}
          trailing={<ShortcutStatusText status={shortcut.status} />}
          chevron
          onPress={() => router.push("/shortcut")}
          testID="lite-shortcut-row"
        />
        <Row
          leading={<Icon name="waveform" fallback="graphic_eq" size={20} color="foreground" />}
          title={t("shortcut:voice.title")}
          onPress={() => router.push("/shortcut")}
          testID="lite-voice-row"
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
          subtitle={t("wallet:linked.rowHint")}
          onPress={() => router.push("/linked-accounts")}
          testID="lite-linked-accounts"
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
          subtitle={t("settings:data.rowHint")}
          onPress={() => router.push("/data")}
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
          subtitle={t("lite:settings.demoHint")}
          onPress={() => router.push("/demo")}
          testID="lite-demo-row"
        />
      </RowGroup>

      <RowGroup
        title={t("lite:settings.dataMode.title")}
        footer={t(`lite:settings.dataMode.${dataMode}Footer`)}
      >
        <Box p={4} testID="data-mode">
          <Segmented<DataMode>
            options={[
              { value: "real", label: t("lite:settings.dataMode.real") },
              { value: "simulated", label: t("lite:settings.dataMode.simulated") },
            ]}
            value={dataMode}
            onChange={setDataMode}
          />
        </Box>
      </RowGroup>

      <RowGroup
        title={t("lite:settings.serverTitle")}
        footer={editServer ? t("lite:settings.serverFooter") : undefined}
      >
        {editServer ? (
          <Box p={4} gap={3}>
            <Input
              label={t("lite:settings.serverLabel")}
              value={server}
              onChangeText={setServer}
              keyboardType="url"
              autoCapitalize="none"
              autoCorrect={false}
              textContentType="URL"
              returnKeyType="done"
              autoFocus
              onSubmitEditing={() => void saveServer()}
              error={serverError ?? undefined}
            />
            <Button variant="outline" onPress={() => void saveServer()}>
              {t("lite:settings.serverSave")}
            </Button>
          </Box>
        ) : (
          <Row
            title={server ? serverHost(server) : t("lite:settings.serverLabel")}
            trailing={
              <Text style={{ color: colors.brandAccent }}>{t("lite:settings.serverChange")}</Text>
            }
            onPress={() => setEditServer(true)}
            testID="server-row"
          />
        )}
      </RowGroup>

      <UpdatesSection />

      <RowGroup>
        <Row
          leading={
            <Icon
              name="rectangle.portrait.and.arrow.right"
              fallback="logout"
              size={22}
              color="destructive"
            />
          }
          title={t("lite:settings.signOut")}
          destructive
          chevron={false}
          onPress={() => void signOut()}
        />
      </RowGroup>
    </ScrollScreen>
  );
}

/** "Working" with a check in the success color; the other states in muted text. */
function ShortcutStatusText({ status }: { status: ShortcutStatus }) {
  const t = useKassaT();
  const label = t(`lite:settings.shortcutStatus.${status}`);
  if (status !== "working") {
    return (
      <Text variant="caption" color="mutedForeground" testID={`shortcut-status-${status}`}>
        {label}
      </Text>
    );
  }
  return (
    <Box row gap={1} align="center" testID="shortcut-status-working">
      <Icon name="checkmark.circle.fill" fallback="check_circle" size={16} color="success" />
      <Text variant="caption" color="success">
        {label}
      </Text>
    </Box>
  );
}
