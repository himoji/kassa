import { View, type FlexAlignType, type ViewStyle } from "react-native";

import { radius as radii, space } from "@/theme/tokens";
import type { BoxAlign, BoxJustify, BoxProps, JustifyContent } from "@/components/ui/types";

import { useTheme } from "./theme-provider";

/**
 * Contract values (flexbox names + the short aliases) → real flexbox values.
 * Aliases that mean nothing on an axis fall back to that axis' default rather
 * than reaching the native style, where they would be invalid.
 */
const JUSTIFY: Record<BoxJustify, JustifyContent> = {
  "flex-start": "flex-start",
  "flex-end": "flex-end",
  center: "center",
  "space-between": "space-between",
  "space-around": "space-around",
  "space-evenly": "space-evenly",
  start: "flex-start",
  end: "flex-end",
  between: "space-between",
  around: "space-around",
  evenly: "space-evenly",
  stretch: "flex-start",
  baseline: "flex-start",
};

const ALIGN: Record<BoxAlign, FlexAlignType> = {
  "flex-start": "flex-start",
  "flex-end": "flex-end",
  center: "center",
  stretch: "stretch",
  baseline: "baseline",
  start: "flex-start",
  end: "flex-end",
  between: "stretch",
  around: "stretch",
  evenly: "stretch",
};

/**
 * Token-typed layout View. Spacing/colour props resolve to inline styles
 * because NativeWind cannot generate `p-${n}` classes at runtime.
 */
export function Box({
  p,
  px,
  py,
  pt,
  pb,
  pl,
  pr,
  m,
  mx,
  my,
  mt,
  mb,
  ml,
  mr,
  gap,
  bg,
  row,
  align,
  justify,
  flex,
  radius,
  border,
  style,
  children,
}: BoxProps) {
  const { colors } = useTheme();
  const base: ViewStyle = {};

  if (p !== undefined) base.padding = space[p];
  if (px !== undefined) base.paddingHorizontal = space[px];
  if (py !== undefined) base.paddingVertical = space[py];
  if (pt !== undefined) base.paddingTop = space[pt];
  if (pb !== undefined) base.paddingBottom = space[pb];
  if (pl !== undefined) base.paddingLeft = space[pl];
  if (pr !== undefined) base.paddingRight = space[pr];
  if (m !== undefined) base.margin = space[m];
  if (mx !== undefined) base.marginHorizontal = space[mx];
  if (my !== undefined) base.marginVertical = space[my];
  if (mt !== undefined) base.marginTop = space[mt];
  if (mb !== undefined) base.marginBottom = space[mb];
  if (ml !== undefined) base.marginLeft = space[ml];
  if (mr !== undefined) base.marginRight = space[mr];
  if (gap !== undefined) base.gap = space[gap];
  if (bg) base.backgroundColor = colors[bg];
  if (row) base.flexDirection = "row";
  if (align) base.alignItems = ALIGN[align];
  if (justify) base.justifyContent = JUSTIFY[justify];
  if (flex !== undefined) base.flex = flex;
  if (radius) base.borderRadius = radii[radius];
  if (border) {
    base.borderWidth = 1;
    base.borderColor = colors.border;
  }

  return <View style={[base, style]}>{children}</View>;
}
