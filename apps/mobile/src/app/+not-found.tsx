import { router, Stack } from "expo-router";

import { useT } from "@/lib/i18n";
import { Box, Button, Screen, Text } from "@/components/ui";

export default function NotFoundRoute() {
  const t = useT();
  return (
    <>
      <Stack.Screen options={{ title: t("Not found") }} />
      <Screen>
        <Box flex={1} align="center" justify="center" gap={4}>
          <Text variant="title" align="center">
            {t("This screen does not exist.")}
          </Text>
          <Button variant="link" onPress={() => router.replace("/")}>
            {t("Go to home")}
          </Button>
        </Box>
      </Screen>
    </>
  );
}
