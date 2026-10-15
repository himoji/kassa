import { router } from "expo-router";
import { useEffect } from "react";

import { useRecoveryCodesStatus } from "@/api/hooks/auth";
import { isLiteBuild } from "@/lite/variant";

/**
 * Backup codes are mandatory: an account with no unused code is sent to the backup-codes step (app/backup-codes.tsx).
 * KassaLite has no such step: codes are made with a passkey, in the full app or on the web.
 */
export function useRequireBackupCodes(): void {
  const status = useRecoveryCodesStatus();
  const missing = !isLiteBuild() && status.data?.remaining === 0;
  useEffect(() => {
    if (missing) router.push("/backup-codes");
  }, [missing]);
}
