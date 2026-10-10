/**
 * Prop types for the components in this folder. Plain types: no stack imports,
 * so a component can be rewritten without touching its public shape.
 */
import type { ReactNode } from "react";
import type {
  FlexAlignType,
  KeyboardTypeOptions,
  StyleProp,
  TextStyle,
  ViewStyle,
} from "react-native";

import type {
  ColorToken,
  FontWeightToken,
  RadiusToken,
  ResolvedMode,
  SpaceToken,
  ThemeColors,
  radius,
  space,
} from "@/theme/tokens";

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export type JustifyContent =
  "flex-start" | "flex-end" | "center" | "space-between" | "space-around" | "space-evenly";

/**
 * Short aliases accepted by `Box`'s `align` / `justify` in addition to the
 * flexbox names. Adapters map them to real flexbox values; an alias that has no
 * meaning on the axis it is used on (`between` on `align`, `baseline` on
 * `justify`) falls back to that axis' default.
 */
export type FlexAlias =
  "start" | "center" | "end" | "between" | "around" | "evenly" | "stretch" | "baseline";

export type BoxAlign = FlexAlignType | FlexAlias;

export type BoxJustify = JustifyContent | FlexAlias;

export interface BoxProps {
  p?: SpaceToken;
  px?: SpaceToken;
  py?: SpaceToken;
  pt?: SpaceToken;
  pb?: SpaceToken;
  pl?: SpaceToken;
  pr?: SpaceToken;
  m?: SpaceToken;
  mx?: SpaceToken;
  my?: SpaceToken;
  mt?: SpaceToken;
  mb?: SpaceToken;
  ml?: SpaceToken;
  mr?: SpaceToken;
  gap?: SpaceToken;
  bg?: ColorToken;
  /** `flexDirection: "row"`. */
  row?: boolean;
  align?: BoxAlign;
  justify?: BoxJustify;
  flex?: number;
  radius?: RadiusToken;
  /** 1px `border` colour border. */
  border?: boolean;
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
}

export type SafeArea = "top" | "bottom" | "both" | "none";

export interface ScreenProps {
  /** Wrap in a ScrollView (keyboard-aware). */
  scroll?: boolean;
  /** Horizontal + vertical padding of `space[4]`. Default true. */
  padded?: boolean;
  /** Which safe-area insets to apply. Default "both". */
  safe?: SafeArea;
  bg?: ColorToken;
  children?: ReactNode;
}

export interface DividerProps {
  /** Vertical margin around the line. */
  spacing?: SpaceToken;
}

// ---------------------------------------------------------------------------
// Typography
// ---------------------------------------------------------------------------

export type TextVariant = "body" | "title" | "heading" | "subtitle" | "caption" | "label" | "code";

export type TextAlign = "auto" | "left" | "right" | "center" | "justify";

export interface TextProps {
  variant?: TextVariant;
  color?: ColorToken;
  weight?: FontWeightToken;
  align?: TextAlign;
  numberOfLines?: number;
  style?: StyleProp<TextStyle>;
  children?: ReactNode;
}

// ---------------------------------------------------------------------------
// Interaction
// ---------------------------------------------------------------------------

export type ButtonVariant = "primary" | "secondary" | "outline" | "ghost" | "destructive" | "link";

export type ButtonSize = "sm" | "md" | "lg" | "icon";

export interface ButtonProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner and disables presses. */
  loading?: boolean;
  disabled?: boolean;
  onPress: () => void;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
}

export interface PressableProps {
  onPress: () => void;
  /** Light haptic on press (native only). Default true. */
  haptic?: boolean;
  /** Pressed-state scale, e.g. 0.97. */
  scale?: number;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
}

export interface CardProps {
  p?: SpaceToken;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
}

export type AutoCapitalize = "none" | "sentences" | "words" | "characters";

export interface InputProps {
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  label?: string;
  /** Error message; when set the field renders in the destructive colour. */
  error?: string;
  secureTextEntry?: boolean;
  keyboardType?: KeyboardTypeOptions;
  autoCapitalize?: AutoCapitalize;
  multiline?: boolean;
  editable?: boolean;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
  style?: StyleProp<ViewStyle>;
}

export interface SwitchProps {
  value: boolean;
  onValueChange: (value: boolean) => void;
  disabled?: boolean;
  label?: string;
}

// ---------------------------------------------------------------------------
// Rows & lists
// ---------------------------------------------------------------------------

/**
 * One line in a settings-style list: leading slot, title/subtitle column,
 * trailing control or chevron.
 *
 * A Row draws **no divider of its own** - stack Rows inside `Card` (with
 * `Divider` between them) or inside `List`, which separates them for you.
 */
export interface RowProps {
  title: string;
  subtitle?: string;
  /**
   * An `Icon` name (rendered in a fixed 28pt leading slot) or any node.
   * Pass a node (`<Icon name="…" fallback="…" />`) when the icon needs a
   * Material fallback for Android/web.
   */
  leading?: IconProps["name"] | ReactNode;
  /** Replaces the chevron, e.g. a `Switch` or a value `Text`. */
  trailing?: ReactNode;
  /** Default: true when `onPress` is set and there is no `trailing`. */
  chevron?: boolean;
  onPress?: () => void;
  onLongPress?: () => void;
  /** Renders the title in the `destructive` colour token. */
  destructive?: boolean;
  disabled?: boolean;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}

/**
 * Virtualised list of `renderItem` results - the only primitive that should
 * render long collections (`.map()` inside `<Screen scroll>` renders everything).
 *
 * A list screen is `<Screen>` (**not** `scroll`) + `<List>`: `Screen` applies the
 * safe-area insets and `List` scrolls inside them, so the two never fight over
 * the bottom inset. Nesting a `List` inside `<Screen scroll>` gives up
 * virtualisation and is only appropriate for a handful of static rows.
 *
 * ```tsx
 * <Screen padded={false}>
 *   <List data={items} renderItem={(item) => <Row title={item.title} onPress={…} />} />
 * </Screen>
 * ```
 */
export interface ListProps<T> {
  data: readonly T[];
  renderItem: (item: T, index: number) => ReactNode;
  /** Default: `item.id` when the item has one, else the index. */
  keyExtractor?: (item: T, index: number) => string;
  /** Default true → a `Divider`, inset to line up with `Row`'s title. */
  separator?: boolean | ReactNode;
  header?: ReactNode;
  footer?: ReactNode;
  /** Rendered in place of the rows when `data` is empty. Default: nothing. */
  empty?: ReactNode;
  refreshing?: boolean;
  onRefresh?: () => void;
  /**
   * Row-height hint. Adapters backed by a measuring list (`FlatList`) ignore it;
   * it exists so a stack can swap in an estimating list without a contract change.
   */
  estimatedItemSize?: number;
  contentContainerStyle?: StyleProp<ViewStyle>;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  /** Grouped/inset look: a rounded card background around the list. Default false. */
  inset?: boolean;
}

// ---------------------------------------------------------------------------
// Feedback & media
// ---------------------------------------------------------------------------

export interface IconProps {
  /** SF Symbol name (expo-symbols). */
  name: string;
  /** Material icon name used where SF Symbols are unavailable (Android/web). */
  fallback?: string;
  size?: number;
  color?: ColorToken;
}

export interface SkeletonProps {
  /** Width in px or percentage string; default "100%". */
  w?: number | `${number}%`;
  /** Height in px; default 16. */
  h?: number;
  radius?: RadiusToken;
  style?: StyleProp<ViewStyle>;
}

export interface LoadingProps {
  size?: "sm" | "lg";
  label?: string;
}

export interface StateAction {
  label: string;
  onPress: () => void;
}

export interface EmptyStateProps {
  title: string;
  description?: string;
  icon?: ReactNode;
  action?: StateAction;
}

export interface ErrorStateProps extends EmptyStateProps {
  retry?: () => void;
}

export type ToastKind = "info" | "success" | "error";

/**
 * `toast.show()` is native where the build allows it: Burnt's system toast on iOS dev and store
 * builds (`@/lib/native-toast`), the stack's own themed card in Expo Go, on Android and web.
 */
export interface ToastOptions {
  title: string;
  description?: string;
  kind?: ToastKind;
  /** Milliseconds; adapters default to ~3000. */
  duration?: number;
}

/**
 * A native bottom sheet: SwiftUI's sheet on iOS (Liquid Glass on iOS 26), Material 3's modal
 * bottom sheet on Android, a drawer on web - one implementation shared by every stack
 * (`BottomSheet` from `@expo/ui`, which runs in Expo Go). Children are ordinary `@/components/ui` views.
 *
 * ```tsx
 * <Sheet visible={open} onClose={() => setOpen(false)} detents={["half", "full"]}>
 *   <Text variant="heading">Details</Text>
 * </Sheet>
 * ```
 */
export interface SheetProps {
  visible: boolean;
  /** Called when the user swipes the sheet away or taps outside it. */
  onClose: () => void;
  /** Heights it can rest at; omit to size it to its content. */
  detents?: ("half" | "full")[];
  /** Grabber at the top. Default true. */
  grabber?: boolean;
  children?: ReactNode;
}

export interface ToastApi {
  show(opts: ToastOptions): void;
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

export interface ThemeProviderProps {
  children?: ReactNode;
}

export interface Theme {
  mode: ResolvedMode;
  colors: ThemeColors;
  space: typeof space;
  radius: typeof radius;
}
