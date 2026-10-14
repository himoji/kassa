import type { ReactNode } from "react";
import { Platform, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { SafeAreaView as ContextSafeAreaView } from "react-native-safe-area-context";
import { SafeAreaView as ScreenSafeAreaView } from "react-native-screens/experimental";

import { useTheme } from "@/components/ui";

interface ChatLayoutProps {
  /** The scrolling transcript (its ScrollView keeps `contentInsetAdjustmentBehavior="automatic"`). */
  children: ReactNode;
  /** The composer pinned to the bottom. */
  composer: ReactNode;
  /** Inside a native tab: the tab bar's inset instead of the home indicator's (Android tabs inset by themselves). */
  inTabs?: boolean;
}

/**
 * A transcript with a composer at the bottom that never hides behind the tab bar, the home indicator or the
 * keyboard.
 *
 * iOS: a native tab or stack screen extends under the (translucent) bars, so the composer sits inside the screen's
 * own safe area (react-native-screens' SafeAreaView reads the screen's `safeAreaInsets`, which include the tab bar;
 * the context SafeAreaView only knows the window's). The keyboard view inside it measures where it is on screen
 * (`automaticOffset`), so it pads by the keyboard minus that inset and the composer lands right on the keyboard.
 * Android: native tabs already inset their content; a stack screen gets the window's bottom inset. Web: no insets.
 */
export function ChatLayout({ children, composer, inTabs = false }: ChatLayoutProps) {
  const { colors } = useTheme();
  const body = (
    <KeyboardAvoidingView behavior="padding" automaticOffset style={{ flex: 1 }}>
      {children}
      {composer}
    </KeyboardAvoidingView>
  );
  const style = { flex: 1, backgroundColor: colors.background };
  if (Platform.OS === "ios") {
    return (
      <ScreenSafeAreaView edges={{ bottom: true }} style={style}>
        {body}
      </ScreenSafeAreaView>
    );
  }
  if (Platform.OS === "android" && !inTabs) {
    return (
      <ContextSafeAreaView edges={["bottom"]} style={style}>
        {body}
      </ContextSafeAreaView>
    );
  }
  return <View style={style}>{body}</View>;
}
