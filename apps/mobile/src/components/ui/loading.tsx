import { ActivityIndicator, View } from "react-native";

import type { LoadingProps } from "@/components/ui/types";

import { Text } from "./text";
import { useTheme } from "./theme-provider";

export function Loading({ size = "sm", label }: LoadingProps) {
  const { colors } = useTheme();
  return (
    <View className="flex-1 items-center justify-center gap-3" aria-busy>
      <ActivityIndicator size={size === "lg" ? "large" : "small"} color={colors.primary} />
      {label ? (
        <Text variant="caption" align="center">
          {label}
        </Text>
      ) : null}
    </View>
  );
}
