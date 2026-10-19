import { TextInput, View } from "react-native";

import type { InputProps } from "@/components/ui/types";

import { cn } from "./cn";
import { Text } from "./text";
import { useTheme } from "./theme-provider";

export function Input({
  value,
  onChangeText,
  placeholder,
  label,
  error,
  secureTextEntry,
  keyboardType,
  autoCapitalize,
  multiline = false,
  editable = true,
  leftIcon,
  rightIcon,
  style,
  ref,
  returnKeyType,
  onSubmitEditing,
  onBlur,
  submitBehavior,
  autoCorrect,
  autoComplete,
  textContentType,
  autoFocus,
  maxLength,
  testID,
}: InputProps) {
  const { colors } = useTheme();

  return (
    <View className="gap-1.5" style={style}>
      {label ? <Text variant="label">{label}</Text> : null}
      <View
        className={cn(
          "bg-background flex-row items-center gap-2 rounded-md border px-3",
          error ? "border-destructive" : "border-input",
          multiline ? "min-h-24 items-start py-2" : "h-11",
          !editable && "opacity-50"
        )}
      >
        {leftIcon}
        <TextInput
          ref={ref}
          testID={testID}
          className="text-foreground flex-1 text-base"
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={colors.mutedForeground}
          secureTextEntry={secureTextEntry}
          keyboardType={keyboardType}
          autoCapitalize={autoCapitalize}
          multiline={multiline}
          editable={editable}
          returnKeyType={returnKeyType}
          onSubmitEditing={onSubmitEditing ? () => onSubmitEditing() : undefined}
          onBlur={onBlur ? () => onBlur() : undefined}
          submitBehavior={submitBehavior}
          autoCorrect={autoCorrect}
          autoComplete={autoComplete}
          textContentType={textContentType}
          autoFocus={autoFocus}
          maxLength={maxLength}
          textAlignVertical={multiline ? "top" : "center"}
          aria-invalid={Boolean(error)}
          aria-label={label}
        />
        {rightIcon}
      </View>
      {error ? (
        <Text variant="caption" color="destructive">
          {error}
        </Text>
      ) : null}
    </View>
  );
}
