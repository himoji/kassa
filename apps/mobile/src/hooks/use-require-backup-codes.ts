import { router } from "expo-router";
import { useEffect } from "react";

import { useRecoveryCodesStatus } from "@/api/hooks/auth";

/** Backup codes are mandatory: an account with no unused code is sent to the backup-codes step (app/backup-codes.tsx). */
export function useRequireBackupCodes(): void {
  const status = useRecoveryCodesStatus();
  const missing = status.data?.remaining === 0;
  useEffect(() => {
    if (missing) router.push("/backup-codes");
  }, [missing]);
}
