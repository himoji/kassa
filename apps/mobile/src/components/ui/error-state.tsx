import { i18n } from "@/lib/i18n";
import type { ErrorStateProps } from "@/components/ui/types";

import { EmptyState } from "./empty-state";
import { Icon } from "./icon";

export function ErrorState({ title, description, icon, action, retry }: ErrorStateProps) {
  return (
    <EmptyState
      title={title}
      description={description}
      icon={
        icon ?? (
          <Icon
            name="exclamationmark.triangle"
            fallback="error_outline"
            size={40}
            color="destructive"
          />
        )
      }
      action={action ?? (retry ? { label: i18n.t("Retry"), onPress: retry } : undefined)}
    />
  );
}
