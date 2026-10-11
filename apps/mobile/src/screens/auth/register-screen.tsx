import { router } from "expo-router";
import { useState } from "react";

import { useRegister } from "@/api/hooks/auth";
import { errorText } from "@/components/kassa/error-text";
import { ScrollScreen } from "@/components/kassa/scroll-screen";
import { Box, Button, Input, Text } from "@/components/ui";
import { haptics } from "@/lib/haptics";
import { useKassaT } from "@/lib/i18n";
import { PasskeyCancelledError } from "@/lib/passkey-errors";

/** Sign-up = create a passkey (spec §8); no password exists anywhere. */
export function RegisterScreen() {
  const t = useKassaT();
  const register = useRegister();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    try {
      const session = await register.mutateAsync({ displayName: name.trim() });
      haptics.success();
      router.replace(session.onboarded ? "/home" : "/onboarding/chat");
    } catch (err) {
      if (err instanceof PasskeyCancelledError) return;
      haptics.error();
      setError(errorText(t, err));
    }
  };

  return (
    <ScrollScreen>
      <Text>{t("auth:register.body")}</Text>
      <Input
        label={t("auth:register.nameLabel")}
        value={name}
        onChangeText={setName}
        placeholder={t("auth:register.namePlaceholder")}
        autoCapitalize="words"
      />
      {error ? <Text color="destructive">{error}</Text> : null}
      <Box gap={3}>
        <Button
          size="lg"
          onPress={() => void submit()}
          loading={register.isPending}
          disabled={!name.trim()}
        >
          {t("auth:register.submit")}
        </Button>
        <Text variant="caption">{t("auth:register.passkeyNote")}</Text>
      </Box>
    </ScrollScreen>
  );
}
