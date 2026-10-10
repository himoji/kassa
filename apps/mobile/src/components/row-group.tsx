import { Children, type ReactNode } from "react";
import { View } from "react-native";

import { Box, Card, Divider, Text } from "@/components/ui";

/** Row padding (16) + leading slot (28) + gap (12): the rule starts under the title. */
const ICON_INSET = 56;
const TEXT_INSET = 16;

interface RowGroupProps {
  /** Small label above the card, iOS inset-grouped style. */
  title?: string;
  /** Explanatory caption under the card. */
  footer?: ReactNode;
  /** Rows carry a leading icon: separators start under the title, not the icon. */
  icons?: boolean;
  /** Rows (or any view); `null`/`false` children are skipped, a separator goes between the rest. */
  children?: ReactNode;
}

/** A titled card of `Row`s with inset separators - the Settings-app grouped list. */
export function RowGroup({ title, footer, icons = false, children }: RowGroupProps) {
  const items = Children.toArray(children);
  return (
    <Box gap={2}>
      {title ? (
        <Box px={4}>
          <Text variant="label" color="mutedForeground">
            {title}
          </Text>
        </Box>
      ) : null}
      <Card p={0} style={{ overflow: "hidden" }}>
        {items.map((item, i) => (
          <View key={i}>
            {i > 0 ? (
              <View style={{ marginStart: icons ? ICON_INSET : TEXT_INSET }}>
                <Divider spacing={0} />
              </View>
            ) : null}
            {item}
          </View>
        ))}
      </Card>
      {footer ? (
        <Box px={4}>
          {typeof footer === "string" ? <Text variant="caption">{footer}</Text> : footer}
        </Box>
      ) : null}
    </Box>
  );
}
