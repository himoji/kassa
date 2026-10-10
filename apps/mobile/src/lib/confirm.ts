/**
 * Ask before a destructive action. Native alert on iOS/Android, `window.confirm`
 * on web (where `Alert.alert` is a no-op). Resolves `true` when the user confirms.
 */
import { Alert, Platform } from "react-native";

export interface ConfirmOptions {
  title: string;
  message?: string;
  /** Label of the confirming button; defaults to "OK". */
  confirmLabel?: string;
  /** Label of the cancel button; defaults to "Cancel". */
  cancelLabel?: string;
  /** Renders the confirming button in the platform's destructive style. */
  destructive?: boolean;
}

export function confirm(opts: ConfirmOptions): Promise<boolean> {
  if (Platform.OS === "web") {
    const text = opts.message ? `${opts.title}\n\n${opts.message}` : opts.title;
    return Promise.resolve(typeof window !== "undefined" && window.confirm(text));
  }
  return new Promise((resolve) => {
    Alert.alert(
      opts.title,
      opts.message,
      [
        { text: opts.cancelLabel ?? "Cancel", style: "cancel", onPress: () => resolve(false) },
        {
          text: opts.confirmLabel ?? "OK",
          style: opts.destructive ? "destructive" : "default",
          onPress: () => resolve(true),
        },
      ],
      { cancelable: true, onDismiss: () => resolve(false) }
    );
  });
}
