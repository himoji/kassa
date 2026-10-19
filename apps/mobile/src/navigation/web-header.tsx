import type { NativeStackHeaderProps } from "expo-router";
import { Pressable, View } from "react-native";

import { Icon, Text, useTheme } from "@/components/ui";

/**
 * Web stack header: title and header buttons sit in the same centred 760px column as ScrollScreen's content,
 * instead of being pinned to the window edges.
 */
export function WebHeader({ navigation, options, route, back }: NativeStackHeaderProps) {
  const { colors } = useTheme();
  const title =
    typeof options.headerTitle === "string" ? options.headerTitle : (options.title ?? route.name);
  const right = options.headerRight?.({ canGoBack: Boolean(back), tintColor: colors.foreground });
  const custom =
    typeof options.headerTitle === "function"
      ? options.headerTitle({ children: title, tintColor: colors.foreground })
      : null;
  return (
    <View style={{ backgroundColor: colors.background }}>
      <View
        style={{
          width: "100%",
          maxWidth: 792,
          alignSelf: "center",
          minHeight: 60,
          paddingHorizontal: 16,
          paddingTop: 12,
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
        }}
      >
        {back ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={back.title ?? "Back"}
            onPress={() => navigation.goBack()}
            style={({ hovered }: { hovered?: boolean }) => ({
              width: 36,
              height: 36,
              borderRadius: 18,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: hovered ? colors.muted : "transparent",
            })}
          >
            <Icon name="chevron.left" fallback="arrow_back" size={20} color="foreground" />
          </Pressable>
        ) : null}
        <View style={{ flex: 1 }}>
          {custom ?? (
            <Text
              numberOfLines={1}
              style={{
                fontSize: back ? 20 : 28,
                lineHeight: back ? 26 : 34,
                fontWeight: "700",
                letterSpacing: -0.4,
              }}
            >
              {title}
            </Text>
          )}
        </View>
        {right}
      </View>
    </View>
  );
}
