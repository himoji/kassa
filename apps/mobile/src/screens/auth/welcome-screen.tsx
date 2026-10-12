import { type Href, router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { KassaApiError } from "@/api/errors";
import { useDemoAvailability, useRegister } from "@/api/hooks/auth";
import { errorText } from "@/components/kassa/error-text";
import { Box, Button, Icon, Text, useTheme } from "@/components/ui";
import {
  DEMO_PERSONAS,
  demoClaimFor,
  parseDemoPersona,
  type DemoPersona,
} from "@/lib/demo-personas";
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

/**
 * "Try the demo": shown only when the API runs in demo mode (GET /auth/demo). It is the normal
 * passkey registration with `demoClaim`, so the new passkey owns the seeded demo account and every
 * payment still needs that passkey (same security model as a real sign-up). The persona chips pick
 * which seeded account to claim (default Dana); `/welcome?persona=<key>` preselects one, validated
 * against the allow-list in `lib/demo-personas`.
 */
function DemoButton() {
  const t = useKassaT();
  const demo = useDemoAvailability();
  const register = useRegister();
  const params = useLocalSearchParams<{ persona?: string }>();
  const [persona, setPersona] = useState<DemoPersona>(() => parseDemoPersona(params.persona));
  const [error, setError] = useState<string | null>(null);
  if (!demo.data?.enabled) return null;

  const start = async () => {
    setError(null);
    try {
      const session = await register.mutateAsync({
        displayName: t(`auth:welcome.personas.${persona}.name`),
        demoClaim: demoClaimFor(persona),
      });
      haptics.success();
      router.replace(
        session.onboarded ? ((peekReturnPath() ?? "/home") as Href) : "/onboarding/chat"
      );
    } catch (err) {
      if (err instanceof PasskeyCancelledError) return;
      haptics.error();
      setError(demoErrorText(t, err));
    }
  };

  return (
    <Box gap={2}>
      <Text variant="caption">{t("auth:welcome.demoPersonaLabel")}</Text>
      <Box row gap={2} style={{ flexWrap: "wrap" }}>
        {DEMO_PERSONAS.map((p) => (
          <Button
            key={p}
            size="sm"
            variant={p === persona ? "secondary" : "outline"}
            disabled={register.isPending}
            onPress={() => {
              setError(null);
              setPersona(p);
            }}
          >
            {t(`auth:welcome.personas.${p}.label`)}
          </Button>
        ))}
      </Box>
      <Button
        size="lg"
        variant="secondary"
        onPress={() => void start()}
        loading={register.isPending}
      >
        {t("auth:welcome.demo")}
      </Button>
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
      <View style={{ flex: 1, padding: 24, justifyContent: "space-between" }}>
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
          <Text variant="caption" align="center">
            {t("auth:welcome.demoNote")}
          </Text>
        </Box>
      </View>
    </SafeAreaView>
  );
}
