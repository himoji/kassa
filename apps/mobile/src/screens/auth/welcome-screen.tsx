import { router } from "expo-router";
import { View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Box, Button, Icon, Text, useTheme } from "@/components/ui";
import { useKassaT } from "@/lib/i18n";

const POINTS = [
  { key: "auth:welcome.point1", sf: "wand.and.stars", md: "auto_awesome" },
  { key: "auth:welcome.point2", sf: "checkmark.shield.fill", md: "verified_user" },
  { key: "auth:welcome.point3", sf: "faceid", md: "fingerprint" },
] as const;

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
          <Text variant="caption" align="center">
            {t("auth:welcome.demoNote")}
          </Text>
        </Box>
      </View>
    </SafeAreaView>
  );
}
