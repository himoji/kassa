import { View } from "react-native";

import type { EmptyStateProps } from "@/components/ui/types";

import { Button } from "./button";
import { Icon } from "./icon";
import { Text } from "./text";

export function EmptyState({ title, description, icon, action }: EmptyStateProps) {
  return (
    <View className="flex-1 items-center justify-center gap-3 p-6">
      {icon ?? <Icon name="tray" fallback="inbox" size={40} color="mutedForeground" />}
      <Text variant="heading" align="center">
        {title}
      </Text>
      {description ? (
        <Text variant="caption" align="center">
          {description}
        </Text>
      ) : null}
      {action ? (
        <Button variant="outline" onPress={action.onPress} style={{ marginTop: 8 }}>
          {action.label}
        </Button>
      ) : null}
    </View>
  );
}
