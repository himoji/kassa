import type { AuthSessionResponse } from "@kassa/shared";
import { type Href, router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { ScrollView, useWindowDimensions, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { KassaApiError } from "@/api/errors";
import { useDemoAvailability, useDevLogin, useRegister } from "@/api/hooks/auth";
import { errorText } from "@/components/kassa/error-text";
import { Logo } from "@/components/kassa/logo";
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
      {demo.data.judgeMode ? (
        <Text variant="caption">{t("auth:welcome.judgeModeNote")}</Text>
      ) : null}
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
  const { width } = useWindowDimensions();
  const wide = width >= 900;

  const hero = (
    <Box gap={6} style={wide ? { flex: 1, maxWidth: 520 } : { paddingTop: 16 }}>
      <Logo size={wide ? 40 : 34} />
      <Text
        variant="title"
        style={{ fontSize: wide ? 56 : 38, lineHeight: wide ? 62 : 44, letterSpacing: -1 }}
      >
        {t("auth:welcome.title")}
      </Text>
      <Text variant="subtitle" style={{ fontSize: wide ? 19 : 17, lineHeight: wide ? 28 : 24 }}>
        {t("auth:welcome.subtitle")}
      </Text>
      <View
        style={{
          gap: 14,
          padding: 16,
          borderRadius: 18,
          backgroundColor: colors.card,
          borderWidth: 1,
          borderColor: colors.border,
        }}
      >
        {POINTS.map((p) => (
          <Box key={p.key} row gap={3} align="center">
            <View
              style={{
                width: 36,
                height: 36,
                borderRadius: 10,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: colors.accent,
              }}
            >
              <Icon name={p.sf} fallback={p.md} size={20} color="brandAccent" />
            </View>
            <Text style={{ flex: 1 }}>{t(p.key)}</Text>
          </Box>
        ))}
      </View>
    </Box>
  );

  const actions = (
    <Box
      gap={3}
      style={
        wide
          ? {
              width: 420,
              padding: 28,
              borderRadius: 24,
              backgroundColor: colors.card,
              borderWidth: 1,
              borderColor: colors.border,
            }
          : undefined
      }
    >
      <Button size="lg" onPress={() => router.push("/register")}>
        {t("auth:welcome.create")}
      </Button>
      <Button size="lg" variant="outline" onPress={() => router.push("/login")}>
        {t("auth:welcome.signIn")}
      </Button>
      <View style={{ height: 1, backgroundColor: colors.border, marginVertical: 4 }} />
      <DemoButton />
      <DevModeButton />
      <Text variant="caption" align="center">
        {t("auth:welcome.demoNote")}
      </Text>
      <Button variant="ghost" onPress={() => router.push("/evidence")}>
        {t("evidence:open")}
      </Button>
    </Box>
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
      <ScrollView
        contentContainerStyle={{
          flexGrow: 1,
          padding: wide ? 48 : 20,
          gap: 28,
          justifyContent: wide ? "center" : "space-between",
        }}
      >
        <View
          style={
            wide
              ? {
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 64,
                  width: "100%",
                  maxWidth: 1080,
                  alignSelf: "center",
                }
              : { flex: 1, justifyContent: "space-between", gap: 28 }
          }
        >
          {hero}
          {actions}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
