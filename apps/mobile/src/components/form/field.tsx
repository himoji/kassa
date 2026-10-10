import { Controller, useFormContext, type FieldValues, type Path } from "react-hook-form";

import { Input } from "@/components/ui";
import type { InputProps } from "@/components/ui/types";

export type FieldProps<T extends FieldValues> = Omit<
  InputProps,
  "value" | "onChangeText" | "error"
> & {
  /** Field path in the form values. */
  name: Path<T>;
};

/**
 * `@/components/ui` Input bound to the enclosing `<Form>` through `Controller`.
 * Shows the field's validation message as the Input `error`.
 */
export function Field<T extends FieldValues>({ name, ...input }: FieldProps<T>) {
  const { control } = useFormContext<T>();

  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => (
        <Input
          {...input}
          value={typeof field.value === "string" ? field.value : String(field.value ?? "")}
          onChangeText={field.onChange}
          error={fieldState.error?.message}
        />
      )}
    />
  );
}
