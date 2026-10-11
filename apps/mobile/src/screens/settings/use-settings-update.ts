import type { SettingsPatchResponse } from "@kassa/shared";

import { useUpdateSettings, type SettingsUpdate } from "@/api/hooks/settings";
import { errorText } from "@/components/kassa/error-text";
import { toast } from "@/components/ui";
import { haptics } from "@/lib/haptics";
import { useKassaT } from "@/lib/i18n";
import { PasskeyCancelledError } from "@/lib/passkey-errors";

/**
 * Apply a settings change and tell the user what happened: tightening applies now, loosening was
 * passkey-signed and waits 24 h (I8). Errors are toasts; the controls stay bound to server state,
 * so a refused change snaps back by itself.
 */
export function useApplySettings() {
  const t = useKassaT();
  const mutation = useUpdateSettings();
  /** `derived`: settings the change switches implicitly (preset → money mode), told to the user explicitly. */
  const apply = async (
    update: SettingsUpdate,
    derived?: string
  ): Promise<SettingsPatchResponse | null> => {
    try {
      const result = await mutation.mutateAsync(update);
      if (result.pending.length > 0) {
        haptics.success();
        toast.show({
          title: t("settings:pendingToastTitle"),
          description: t("settings:pendingToastBody"),
        });
      } else {
        haptics.selection();
        toast.show({
          title: t("settings:appliedToast"),
          ...(derived ? { description: t("settings:derivedToast", { changes: derived }) } : {}),
          kind: "success",
        });
      }
      return result;
    } catch (err) {
      if (err instanceof PasskeyCancelledError) return null;
      haptics.error();
      toast.show({ title: errorText(t, err), kind: "error" });
      return null;
    }
  };
  return { apply, pending: mutation.isPending };
}
