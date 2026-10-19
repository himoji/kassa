import { useRequireBackupCodes } from "@/hooks/use-require-backup-codes";
import { LiteHomeScreen } from "@/screens/lite/home-screen";

/** The same card-deck Home as KassaLite; the full app's long Home (screens/home) stays for reference. */
export default function Route() {
  useRequireBackupCodes();
  return <LiteHomeScreen />;
}
