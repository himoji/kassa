/**
 * The primary "… with passkey" action. In a dev build against a server with dev sign-in on (GET /auth/demo
 * `devLogin`), a "Dev" button sits right next to it: same action, but the challenge is signed by the server-held dev
 * key (api/passkey-sign `armDevPasskey`, POST /auth/dev/assert) instead of the platform passkey prompt. A dev-login
 * session already signs that way from the main button, so it gets no extra button.
 */
import { View } from "react-native";

import { useDemoAvailability } from "@/api/hooks/auth";
import { armDevPasskey } from "@/api/passkey-sign";
import { Box, Button, Icon } from "@/components/ui";
import type { ButtonProps } from "@/components/ui/types";
import { useKassaT } from "@/lib/i18n";
import { useSessionStore } from "@/stores/session";

export function useDevPasskeyAvailable(): boolean {
  const demo = useDemoAvailability();
  const devSession = useSessionStore((s) => s.dev);
  return __DEV__ && demo.data?.devLogin === true && !devSession;
}

export function PasskeyButton({
  onPress,
  disabled,
  loading,
  ...rest
}: Omit<ButtonProps, "leftIcon">) {
  const t = useKassaT();
  const dev = useDevPasskeyAvailable();
  const main = (
    <Button
      size="lg"
      {...rest}
      onPress={onPress}
      disabled={disabled}
      loading={loading}
      leftIcon={<Icon name="faceid" fallback="fingerprint" size={20} color="primaryForeground" />}
    />
  );
  if (!dev) return main;
  return (
    <Box row gap={2}>
      <View style={{ flex: 1 }}>{main}</View>
      <View accessibilityLabel={t("common:devPasskeyLabel")} testID="dev-passkey-button">
        <Button
          size={rest.size ?? "lg"}
          variant="outline"
          disabled={disabled || loading}
          onPress={() => {
            armDevPasskey();
            onPress();
          }}
        >
          {t("common:devPasskey")}
        </Button>
      </View>
    </Box>
  );
}
