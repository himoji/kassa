import type { AuthSessionResponse } from "@kassa/shared";
import { type Href, router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { KassaApiError } from "@/api/errors";
import { useDemoAvailability, useDevLogin, useRegister } from "@/api/hooks/auth";
import { errorText } from "@/components/kassa/error-text";
import { Box, Button, Icon, Text, useTheme } from "@/components/ui";
import {
  demoClaimFor,
  parseDemoPersona,
  visibleDemoPersonas,
  type DemoPersona,
} from "@/lib/demo-personas";
import { env } from "@/lib/env";
import { haptics } from "@/lib/haptics";
import { useKassaT, type TFn } from "@/lib/i18n";
import { PasskeyCancelledError } from "@/lib/passkey-errors";
import { peekReturnPath } from "@/lib/return-path";

const POINTS = [
  { key: "auth:welcome.point1", sf: "wand.and.stars", md: "auto_awesome" },
  { key: "auth:welcome.point2", sf: "checkmark.shield.fill", md: "verified_user" },
  { key: "auth:welcome.point3", sf: "faceid", md: "fingerprint" },
] as const;

/** Demo-claim refusals get their own text; everything else (incl. passkey domain) is generic. */
function demoErrorText(t: TFn, err: unknown): string {
  if (err instanceof KassaApiError && err.code === "DEMO_ALREADY_CLAIMED")
    return t("auth:welcome.demoClaimed");
  if (err instanceof KassaApiError && err.code === "DEMO_NOT_SEEDED")
    return t("auth:welcome.demoNotSeeded");
  if (err instanceof KassaApiError && err.code === "DEMO_PERSONA_UNKNOWN")
    return t("auth:welcome.demoPersonaUnknown");
  return errorText(t, err);
}

/** The one success path for every sign-in on this screen (passkey register, demo, dev login). */
function continueSignedIn(session: AuthSessionResponse): void {
  haptics.success();
  router.replace(session.onboarded ? ((peekReturnPath() ?? "/home") as Href) : "/onboarding/chat");
}

/**
 * Dev mode: shown only when GET /auth/demo reports `devLogin` (server dev/demo builds). POST /auth/dev/login
 * with `fresh` starts a brand-new account every time (onboarding from the start), no passkey ceremony; its
 * later passkey signing is done by the server (api/passkey-sign).
 */
function DevModeButton() {
  const t = useKassaT();
  const demo = useDemoAvailability();
  const devLogin = useDevLogin();
  const [error, setError] = useState<string | null>(null);
  if (!demo.data?.devLogin) return null;

  const start = async () => {
    setError(null);
    try {
      continueSignedIn(await devLogin.mutateAsync({ fresh: true }));
    } catch (err) {
      haptics.error();
      setError(errorText(t, err));
    }
  };

  return (
    <Box gap={2}>
      <Text variant="label">{t("auth:welcome.devModeLabel")}</Text>
      <Button size="lg" variant="outline" onPress={() => void start()} loading={devLogin.isPending}>
        {t("auth:welcome.devLogin")}
      </Button>
      <Text variant="caption">{t("auth:welcome.devModeNote")}</Text>
      {demo.data.judgeMode ? <Text variant="caption">{t("auth:welcome.judgeModeNote")}</Text> : null}
      {error ? (
        <Text color="destructive" align="center">
          {error}
        </Text>
      ) : null}
    </Box>
  );
}

/**
 * Demo mode: shown only when the API runs in demo mode (GET /auth/demo). "Try the demo" is the normal
 * passkey registration with `demoClaim`, so the new passkey owns the seeded demo account and every
 * payment still needs that passkey (same security model as a real sign-up). With dev sign-in on, a "Dev"
 * button next to it enters the same account with no passkey (POST /auth/dev/login `demoClaim`). The
 * persona chips pick which seeded account (default Dana); `/welcome?persona=<key>` preselects one,
 * validated against the allow-list in `lib/demo-personas`.
 */
function DemoButton() {
  const t = useKassaT();
  const demo = useDemoAvailability();
  const register = useRegister();
  const devLogin = useDevLogin();
  const params = useLocalSearchParams<{ persona?: string }>();
  const [persona, setPersona] = useState<DemoPersona>(() => parseDemoPersona(params.persona));
  const [error, setError] = useState<string | null>(null);
  if (!demo.data?.enabled) return null;
  const pending = register.isPending || devLogin.isPending;
  const judge = demo.data.judgeMode === true && demo.data.devLogin;

  const start = async (dev: boolean) => {
    setError(null);
    try {
      const session = dev
        ? await devLogin.mutateAsync({ demoClaim: demoClaimFor(persona) })
        : await register.mutateAsync({
            displayName: t(`auth:welcome.personas.${persona}.name`),
            demoClaim: demoClaimFor(persona),
          });
      continueSignedIn(session);
    } catch (err) {
      if (err instanceof PasskeyCancelledError) return;
      haptics.error();
      setError(demoErrorText(t, err));
    }
  };

  return (
    <Box gap={2}>
      <Text variant="label">{t("auth:welcome.demoModeLabel")}</Text>
      <Text variant="caption">{t("auth:welcome.demoPersonaLabel")}</Text>
      <Box row gap={2} style={{ flexWrap: "wrap" }}>
        {visibleDemoPersonas(persona, env.SHOW_BUSINESS === "true").map((p) => (
          <Button
            key={p}
            size="sm"
            variant={p === persona ? "secondary" : "outline"}
            disabled={pending}
            onPress={() => {
              setError(null);
              setPersona(p);
            }}
          >
            {t(`auth:welcome.personas.${p}.label`)}
          </Button>
        ))}
      </Box>
      <Box row gap={2}>
        <View style={{ flex: 1 }}>
          <Button
            size="lg"
            variant="secondary"
            // Judge build: no passkey device needed, the main button signs in with the server-held key.
            onPress={() => void start(judge)}
            loading={judge ? devLogin.isPending : register.isPending}
            disabled={judge ? register.isPending : devLogin.isPending}
          >
            {t("auth:welcome.demo")}
          </Button>
        </View>
        {demo.data.devLogin && !judge ? (
          <View accessibilityLabel={t("common:devPasskeyLabel")} testID="demo-dev-button">
            <Button
              size="lg"
              variant="outline"
              onPress={() => void start(true)}
              loading={devLogin.isPending}
              disabled={register.isPending}
            >
              {t("common:devPasskey")}
            </Button>
          </View>
        ) : null}
      </Box>
      {error ? (
        <Text color="destructive" align="center">
          {error}
        </Text>
      ) : null}
    </Box>
  );
}

export function WelcomeScreen() {
  const t = useKassaT();
  const { colors } = useTheme();
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
      <ScrollView
        contentContainerStyle={{
          flexGrow: 1,
          padding: 24,
          gap: 24,
          justifyContent: "space-between",
        }}
      >
        <Box gap={6} style={{ paddingTop: 48 }}>
          <Text variant="title" style={{ fontSize: 40, lineHeight: 46 }}>
            {t("auth:welcome.title")}
          </Text>
          <Text variant="subtitle">{t("auth:welcome.subtitle")}</Text>
          <Box gap={4}>
            {POINTS.map((p) => (
              <Box key={p.key} row gap={3} align="center">
                <Icon name={p.sf} fallback={p.md} size={24} color="brandAccent" />
                <Text style={{ flex: 1 }}>{t(p.key)}</Text>
              </Box>
            ))}
          </Box>
        </Box>
        <Box gap={3}>
          <Button size="lg" onPress={() => router.push("/register")}>
            {t("auth:welcome.create")}
          </Button>
          <Button size="lg" variant="outline" onPress={() => router.push("/login")}>
            {t("auth:welcome.signIn")}
          </Button>
          <DemoButton />
          <DevModeButton />
          <Text variant="caption" align="center">
            {t("auth:welcome.demoNote")}
          </Text>
          <Button variant="ghost" onPress={() => router.push("/evidence")}>
            {t("evidence:open")}
          </Button>
        </Box>
      </ScrollView>
    </SafeAreaView>
  );
}
