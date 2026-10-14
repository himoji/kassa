import { useEffect, useState } from "react";
import { Linking } from "react-native";

import { errorText } from "@/components/kassa/error-text";
import { ScrollScreen } from "@/components/kassa/scroll-screen";
import { RowGroup } from "@/components/row-group";
import { Box, Button, Icon, Input, Row, Text, toast, useTheme } from "@/components/ui";
import { copyToClipboard } from "@/lib/clipboard";
import { confirm } from "@/lib/confirm";
import { useKassaT } from "@/lib/i18n";
import { loadDisplayName } from "@/lite/profile";
import {
  applyServerUrl,
  loadServerUrl,
  normalizeServerUrl,
  saveServerUrl,
  shortcutEndpointFor,
} from "@/lite/server-url";
import { loadShortcutToken } from "@/lite/shortcut-token";
import { liteSignOut } from "@/lite/sign-out";
import { shortcutTemplateUrl } from "@/lite/variant";

import { UpdatesSection } from "./updates-section";

const STEPS = ["1", "2", "3", "4", "5", "6"] as const;

/** What the person pastes into the Shortcut: the endpoint, then the Authorization header value. */
export function shortcutClipboardText(serverUrl: string, token: string): string {
  return `${shortcutEndpointFor(serverUrl)}\nBearer ${token}`;
}

/** "kassa-sand.vercel.app" for the stored `https://` origin. */
export function serverHost(url: string): string {
  return url.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}

/** KassaLite settings: pairing state, Shortcut install, server URL, sign out. */
export function LiteSettingsScreen() {
  const t = useKassaT();
  const { colors } = useTheme();
  const [name, setName] = useState<string | null>(null);
  const [server, setServer] = useState("");
  const [serverError, setServerError] = useState<string | null>(null);
  const [showSteps, setShowSteps] = useState(false);
  const [editServer, setEditServer] = useState(false);
  const template = shortcutTemplateUrl();

  useEffect(() => {
    void loadDisplayName().then(setName);
    void loadServerUrl().then((s) => s && setServer(s));
  }, []);

  const install = async () => {
    const [token, stored] = await Promise.all([loadShortcutToken(), loadServerUrl()]);
    if (!token || !stored) {
      toast.show({ title: t("lite:settings.noShortcutToken"), kind: "error" });
      return;
    }
    await copyToClipboard(shortcutClipboardText(stored, token), {
      toast: t("lite:settings.copiedToast"),
    });
    if (template) {
      try {
        await Linking.openURL(template);
      } catch (err) {
        toast.show({ title: errorText(t, err), kind: "error" });
      }
    }
  };

  const saveServer = async () => {
    const normalized = normalizeServerUrl(server);
    if (!normalized) {
      setServerError(t("lite:settings.serverInvalid"));
      return;
    }
    setServerError(null);
    await saveServerUrl(normalized);
    applyServerUrl(normalized);
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

      <RowGroup
        title={t("lite:settings.shortcutTitle")}
        footer={template ? t("lite:settings.installShortcutFooter") : t("lite:settings.copyFooter")}
      >
        <Box p={4} gap={4}>
          <Box row gap={3} align="center">
            <Icon
              name="wave.3.right.circle.fill"
              fallback="contactless"
              size={32}
              color="brandAccent"
            />
            <Text variant="caption" style={{ flex: 1 }}>
              {t("lite:settings.shortcutIntro")}
            </Text>
          </Box>
          <Button variant="outline" onPress={() => void install()}>
            {template ? t("lite:settings.installShortcut") : t("lite:settings.copyAgain")}
          </Button>
        </Box>
        <Row
          leading={
            <Icon
              name="list.number"
              fallback="format_list_numbered"
              size={22}
              color="brandAccent"
            />
          }
          title={t("lite:settings.stepsTitle")}
          trailing={
            <Icon
              name={showSteps ? "chevron.up" : "chevron.down"}
              fallback={showSteps ? "expand_less" : "expand_more"}
              size={14}
              color="mutedForeground"
            />
          }
          onPress={() => setShowSteps((v) => !v)}
          testID="shortcut-steps"
        />
        {showSteps ? (
          <Box px={4} pb={4} gap={3}>
            {STEPS.map((n) => (
              <Box key={n} row gap={3}>
                <Box
                  align="center"
                  justify="center"
                  style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: colors.muted }}
                >
                  <Text variant="caption" weight="semibold">
                    {n}
                  </Text>
                </Box>
                <Text variant="caption" style={{ flex: 1, color: colors.foreground }}>
                  {t(`lite:settings.steps.${n}`)}
                </Text>
              </Box>
            ))}
          </Box>
        ) : null}
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
