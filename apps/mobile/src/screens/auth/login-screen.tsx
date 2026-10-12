import { type Href, router } from "expo-router";
import { useState } from "react";

import { useLogin } from "@/api/hooks/auth";
import { errorText } from "@/components/kassa/error-text";
import { ScrollScreen } from "@/components/kassa/scroll-screen";
import { Box, Button, Text } from "@/components/ui";
import { haptics } from "@/lib/haptics";
import { useKassaT } from "@/lib/i18n";
import { PasskeyCancelledError } from "@/lib/passkey-errors";
import { peekReturnPath } from "@/lib/return-path";

/** Sign-in with a discoverable passkey (WebAuthn L3 §5.1.4, no username needed). */
export function LoginScreen() {
  const t = useKassaT();
  const login = useLogin();
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    try {
      const session = await login.mutateAsync();
      haptics.success();
      router.replace(
        session.onboarded ? ((peekReturnPath() ?? "/home") as Href) : "/onboarding/chat"
      );
    } catch (err) {
      if (err instanceof PasskeyCancelledError) return;
      haptics.error();
      setError(errorText(t, err));
    }
  };

  return (
    <ScrollScreen>
      <Text>{t("auth:login.body")}</Text>
      {error ? <Text color="destructive">{error}</Text> : null}
      <Box gap={3}>
        <Button size="lg" onPress={() => void submit()} loading={login.isPending}>
          {t("auth:login.submit")}
        </Button>
        <Button variant="ghost" onPress={() => router.replace("/register")}>
          {t("auth:login.noAccount")}
        </Button>
      </Box>
    </ScrollScreen>
  );
}
