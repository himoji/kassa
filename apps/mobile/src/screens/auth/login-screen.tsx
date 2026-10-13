import { type Href, router } from "expo-router";
import { useState } from "react";

import { useLogin, useRecover } from "@/api/hooks/auth";
import { errorText } from "@/components/kassa/error-text";
import { ScrollScreen } from "@/components/kassa/scroll-screen";
import { Box, Button, Input, Text, toast } from "@/components/ui";
import { haptics } from "@/lib/haptics";
import { useKassaT } from "@/lib/i18n";
import { PasskeyCancelledError } from "@/lib/passkey-errors";
import { peekReturnPath } from "@/lib/return-path";

/** Lost passkey: a backup code gives this device a new passkey (the old ones stop working). */
function RecoverWithCode({ onCancel }: { onCancel: () => void }) {
  const t = useKassaT();
  const recover = useRecover();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    try {
      const session = await recover.mutateAsync(code.trim());
      haptics.success();
      toast.show({
        title: t("auth:recover.done"),
        description: t("auth:recover.frozen", { count: session.recovery.codesLeft }),
      });
      router.replace(session.onboarded ? "/settings" : "/onboarding/chat");
    } catch (err) {
      if (err instanceof PasskeyCancelledError) return;
      haptics.error();
      setError(errorText(t, err));
    }
  };

  return (
    <Box gap={3}>
      <Text weight="semibold">{t("auth:recover.title")}</Text>
      <Text variant="caption">{t("auth:recover.body")}</Text>
      <Input
        label={t("auth:recover.codeLabel")}
        placeholder="XXXXX-XXXXX"
        value={code}
        onChangeText={setCode}
        autoCapitalize="characters"
      />
      {error ? <Text color="destructive">{error}</Text> : null}
      <Button
        size="lg"
        disabled={code.replace(/[\s-]/g, "").length < 10}
        loading={recover.isPending}
        onPress={() => void submit()}
      >
        {t("auth:recover.submit")}
      </Button>
      <Button variant="ghost" onPress={onCancel}>
        {t("auth:recover.cancel")}
      </Button>
    </Box>
  );
}

/** Sign-in with a discoverable passkey (WebAuthn L3 §5.1.4, no username needed). */
export function LoginScreen() {
  const t = useKassaT();
  const login = useLogin();
  const [error, setError] = useState<string | null>(null);
  const [recovering, setRecovering] = useState(false);

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

  if (recovering) {
    return (
      <ScrollScreen>
        <RecoverWithCode onCancel={() => setRecovering(false)} />
      </ScrollScreen>
    );
  }

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
        <Button variant="ghost" onPress={() => setRecovering(true)}>
          {t("auth:login.lost")}
        </Button>
      </Box>
    </ScrollScreen>
  );
}
