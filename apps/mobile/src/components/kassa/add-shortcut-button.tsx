import { Linking } from "react-native";

import { errorText } from "@/components/kassa/error-text";
import { Box, Button, Text, toast } from "@/components/ui";
import { copyToClipboard } from "@/lib/clipboard";
import { haptics } from "@/lib/haptics";
import { useKassaT } from "@/lib/i18n";

/**
 * "Add the Shortcut": copies the one value the published Shortcut's import question asks for (the link with the key,
 * only on this tap) and opens its iCloud link, where Shortcuts shows "Add Shortcut". `after` says what is left.
 * `pasteValue` is read on the tap, so a key loaded from storage is never held in a render.
 */
export function AddShortcutButton({
  link,
  pasteValue,
  label,
  after,
}: {
  link: string;
  pasteValue: () => Promise<string | null> | string | null;
  label: string;
  after: string;
}) {
  const t = useKassaT();
  const onPress = async () => {
    const value = await pasteValue();
    if (!value) {
      haptics.error();
      toast.show({ title: t("shortcut:quick.needToken"), kind: "error" });
      return;
    }
    if (!(await copyToClipboard(value, { toast: false }))) {
      haptics.error();
      toast.show({ title: t("shortcut:quick.copyFailed"), kind: "error" });
      return;
    }
    haptics.success();
    try {
      await Linking.openURL(link);
    } catch (err) {
      toast.show({ title: errorText(t, err), kind: "error" });
    }
  };
  return (
    <Box gap={2}>
      <Button onPress={() => void onPress()}>{label}</Button>
      <Text variant="caption">{after}</Text>
    </Box>
  );
}
