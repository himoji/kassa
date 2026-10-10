import { View } from "react-native";

import { space } from "@/theme/tokens";
import type { CardProps } from "@/components/ui/types";

import { Pressable } from "./pressable";

export function Card({ p = 4, onPress, style, children }: CardProps) {
  const body = (
    <View
      className="bg-card border-border rounded-lg border"
      style={[{ padding: space[p] }, style]}
    >
      {children}
    </View>
  );
  return onPress ? <Pressable onPress={onPress}>{body}</Pressable> : body;
}
