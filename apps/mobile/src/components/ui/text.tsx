import { I18nManager } from "react-native";

import { fontWeight } from "@/theme/tokens";
import type { TextProps, TextVariant } from "@/components/ui/types";

import { Text as RnrText } from "./rnr-text";
import { useTheme } from "./theme-provider";

type RnrVariant = NonNullable<React.ComponentProps<typeof RnrText>["variant"]>;

/** Contract variants → RNR typography variants. */
const VARIANT: Record<TextVariant, RnrVariant> = {
  body: "default",
  title: "h3",
  heading: "h4",
  subtitle: "lead",
  caption: "muted",
  label: "small",
  code: "code",
};

/**
 * Unaligned text follows the layout direction. iOS resolves "natural" alignment from the
 * text itself, so an Arabic UI left-aligns Latin strings (and, on Fabric, Arabic ones too);
 * `left` is swapped to `right` under RTL, which puts every label at the reading start.
 */
const START = { textAlign: "left" } as const;

export function Text({
  variant = "body",
  color,
  weight,
  align,
  numberOfLines,
  style,
  children,
}: TextProps) {
  const { colors } = useTheme();
  return (
    <RnrText
      variant={VARIANT[variant]}
      numberOfLines={numberOfLines}
      style={[
        color ? { color: colors[color] } : null,
        weight ? { fontWeight: fontWeight[weight] } : null,
        align ? { textAlign: align } : I18nManager.isRTL ? START : null,
        style,
      ]}
    >
      {children}
    </RnrText>
  );
}
