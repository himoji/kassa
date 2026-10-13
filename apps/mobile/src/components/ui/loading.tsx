import { View } from "react-native";

import type { LoadingProps } from "@/components/ui/types";

import { Spinner } from "./spinner";
import { Text } from "./text";

export function Loading({ size = "sm", label }: LoadingProps) {
  return (
    <View className="flex-1 items-center justify-center gap-3" aria-busy>
      <Spinner size={size === "lg" ? "lg" : "sm"} />
      {label ? (
        <Text variant="caption" align="center">
          {label}
        </Text>
      ) : null}
    </View>
  );
}
