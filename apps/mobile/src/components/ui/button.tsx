import { ActivityIndicator } from "react-native";

import type { ButtonProps, ButtonSize, ButtonVariant } from "@/components/ui/types";

import { Button as RnrButton } from "./rnr-button";
import { Text as RnrText } from "./rnr-text";
import { useTheme } from "./theme-provider";

type RnrVariant = NonNullable<React.ComponentProps<typeof RnrButton>["variant"]>;
type RnrSize = NonNullable<React.ComponentProps<typeof RnrButton>["size"]>;

const VARIANT: Record<ButtonVariant, RnrVariant> = {
  primary: "default",
  secondary: "secondary",
  outline: "outline",
  ghost: "ghost",
  destructive: "destructive",
  link: "link",
};

const SIZE: Record<ButtonSize, RnrSize> = {
  sm: "sm",
  md: "default",
  lg: "lg",
  icon: "icon",
};

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  disabled = false,
  onPress,
  leftIcon,
  rightIcon,
  style,
  children,
}: ButtonProps) {
  const { colors } = useTheme();
  const spinnerColor =
    variant === "primary"
      ? colors.primaryForeground
      : variant === "destructive"
        ? colors.destructiveForeground
        : colors.foreground;

  return (
    <RnrButton
      variant={VARIANT[variant]}
      size={SIZE[size]}
      disabled={disabled || loading}
      onPress={onPress}
      aria-busy={loading}
      style={style}
    >
      {loading ? <ActivityIndicator size="small" color={spinnerColor} /> : leftIcon}
      {typeof children === "string" ? <RnrText>{children}</RnrText> : children}
      {rightIcon}
    </RnrButton>
  );
}
