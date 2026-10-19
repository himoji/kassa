import { useShortcutDevices } from "@/api/hooks/shortcut";
import { ScrollScreen } from "@/components/kassa/scroll-screen";

import { ShortcutSetup } from "./shortcut-setup";
import { VoiceShortcut } from "./voice-shortcut";

/** KassaLite Settings → "Apple Pay & Siri": the Apple Pay Shortcut card and the voice Shortcut, in full. */
export function LiteShortcutScreen() {
  const devices = useShortcutDevices();
  return (
    <ScrollScreen onRefresh={() => devices.refetch()} testID="lite-shortcut-screen">
      <ShortcutSetup />
      <VoiceShortcut />
    </ScrollScreen>
  );
}
