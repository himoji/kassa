import type { ReactNode } from "react";
import { FormProvider, type FieldValues, type UseFormReturn } from "react-hook-form";

export interface FormProps<T extends FieldValues> {
  form: UseFormReturn<T>;
  children?: ReactNode;
}

/** `FormProvider` wrapper so nested `<Field>`s bind to the form via context. */
export function Form<T extends FieldValues>({ form, children }: FormProps<T>) {
  return <FormProvider {...form}>{children}</FormProvider>;
}
