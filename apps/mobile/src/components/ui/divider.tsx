import { View } from "react-native";

import { space } from "@/theme/tokens";
import type { DividerProps } from "@/components/ui/types";

export function Divider({ spacing = 4 }: DividerProps) {
  return (
    <View
      role="separator"
      className="border-border border-b"
      style={{ marginVertical: space[spacing] }}
    />
  );
}
