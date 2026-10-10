/**
 * "Confirm with your password" sheet, used before sensitive actions a provider only allows
 * on a fresh sign-in (Better Auth account deletion). `usePasswordPrompt()` returns the element
 * to render and `ask()`, which resolves with the password or `null` when cancelled.
 */
import { useCallback, useRef, useState, type ReactNode } from "react";
import { Modal } from "react-native";

import { useT } from "@/lib/i18n";
import { Box, Button, Input, Screen, Text } from "@/components/ui";

export interface AskPasswordOptions {
  /** The last password was wrong: say so above the field. */
  retry?: boolean;
}

export function usePasswordPrompt(): [
  ReactNode,
  (opts?: AskPasswordOptions) => Promise<string | null>,
] {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [retry, setRetry] = useState(false);
  const [password, setPassword] = useState("");
  const resolver = useRef<((value: string | null) => void) | null>(null);

  const finish = (value: string | null): void => {
    resolver.current?.(value);
    resolver.current = null;
    setOpen(false);
    setPassword("");
  };

  const ask = useCallback((opts: AskPasswordOptions = {}) => {
    resolver.current?.(null);
    setRetry(opts.retry === true);
    setOpen(true);
    return new Promise<string | null>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const element = open ? (
    <Modal
      visible
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={() => finish(null)}
    >
      <Screen safe="both">
        <Box gap={4}>
          <Text variant="title">{t("Confirm it's you")}</Text>
          <Text color="mutedForeground">
            {t("Enter your password to permanently delete your account.")}
          </Text>
          <Input
            label={t("Password")}
            placeholder={t("Password")}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoCapitalize="none"
            error={retry ? t("That password is not right.") : undefined}
          />
          <Button
            variant="destructive"
            onPress={() => finish(password)}
            disabled={password.length === 0}
          >
            {t("Delete account")}
          </Button>
          <Button variant="ghost" onPress={() => finish(null)}>
            {t("Cancel")}
          </Button>
        </Box>
      </Screen>
    </Modal>
  ) : null;

  return [element, ask];
}
