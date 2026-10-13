import { router, useLocalSearchParams, type Href } from "expo-router";
import { useEffect, useState } from "react";

import { Box, Button, Input, Screen, Text } from "@/components/ui";
import { useKassaT } from "@/lib/i18n";
import { errorText } from "@/components/kassa/error-text";
import {
  completePairing,
  isValidCode,
  normalizeCode,
  PairInputError,
  PairNoSessionError,
} from "@/lite/pair";
import { loadServerUrl, normalizeServerUrl } from "@/lite/server-url";

function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

/**
 * Pair this iPhone with a Kassa account: type the 8-character code (Settings → Pair KassaLite in the
 * full app) or arrive from `kassalite://pair?code=…&server=…`. A link only pre-fills the form: the
 * person confirms the server shown here, so a crafted link cannot silently bind the phone to another server.
 */
export function PairScreen() {
  const t = useKassaT();
  const params = useLocalSearchParams<{ code?: string; server?: string }>();
  const [code, setCode] = useState(() => normalizeCode(first(params.code)));
  const [server, setServer] = useState(() => first(params.server));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // A new link while the screen is open replaces the fields (adjusting state during render).
  const linkCode = first(params.code);
  const linkServer = first(params.server);
  const [seenLink, setSeenLink] = useState({ linkCode, linkServer });
  if (seenLink.linkCode !== linkCode || seenLink.linkServer !== linkServer) {
    setSeenLink({ linkCode, linkServer });
    if (linkCode) setCode(normalizeCode(linkCode));
    if (linkServer) setServer(linkServer);
  }

  // No server in the link: offer the one stored from an earlier pairing.
  useEffect(() => {
    if (linkServer) return;
    void loadServerUrl().then((stored) => {
      if (stored) setServer((current) => current || stored);
    });
  }, [linkServer]);

  const submit = async () => {
    setError(null);
    if (!isValidCode(normalizeCode(code))) return setError(t("lite:pair.invalidCode"));
    if (!normalizeServerUrl(server)) return setError(t("lite:pair.invalidServer"));
    setBusy(true);
    try {
      await completePairing({ code, server, deviceName: t("lite:pair.deviceName") });
      router.replace("/activity" as Href);
    } catch (err) {
      if (err instanceof PairInputError) {
        setError(t(err.field === "code" ? "lite:pair.invalidCode" : "lite:pair.invalidServer"));
      } else if (err instanceof PairNoSessionError) {
        setError(t("lite:pair.noTokens"));
      } else {
        setError(`${t("lite:pair.failed")} (${errorText(t, err)})`);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen scroll>
      <Box gap={4}>
        <Text variant="title">{t("lite:pair.title")}</Text>
        <Text variant="caption">{t("lite:pair.intro")}</Text>
        <Input
          label={t("lite:pair.codeLabel")}
          placeholder={t("lite:pair.codePlaceholder")}
          value={code}
          onChangeText={(text) => setCode(normalizeCode(text).slice(0, 8))}
          autoCapitalize="characters"
        />
        <Input
          label={t("lite:pair.serverLabel")}
          placeholder={t("lite:pair.serverPlaceholder")}
          value={server}
          onChangeText={setServer}
          keyboardType="url"
          autoCapitalize="none"
        />
        {error ? (
          <Text color="destructive" testID="pair-error">
            {error}
          </Text>
        ) : null}
        <Button onPress={() => void submit()} loading={busy}>
          {t("lite:pair.submit")}
        </Button>
      </Box>
    </Screen>
  );
}
