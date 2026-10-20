import { router, type Href } from "expo-router";
import { useState } from "react";

import { useExportData } from "@/api/hooks/dataport";
import { RowGroup } from "@/components/row-group";
import { errorText } from "@/components/kassa/error-text";
import { ScrollScreen } from "@/components/kassa/scroll-screen";
import { Box, Button, Text } from "@/components/ui";
import { useKassaT } from "@/lib/i18n";

/**
 * Import & export (Settings, in the app and in KassaLite): Kassa's JSON export, and the way to the Import screen
 * (screens/import), which Home and the Add page also open: importing is not a settings task.
 */
export function DataScreen() {
  const t = useKassaT();
  const exportData = useExportData();
  const [error, setError] = useState<string | null>(null);

  return (
    <ScrollScreen>
      <RowGroup title={t("settings:data.importTitle")} footer={t("settings:data.importFooter")}>
        <Box p={4}>
          <Button onPress={() => router.push("/import" as Href)}>
            {t("settings:data.chooseFile")}
          </Button>
        </Box>
      </RowGroup>

      <RowGroup title={t("settings:data.exportTitle")} footer={t("settings:data.exportFooter")}>
        <Box p={4}>
          <Button
            variant="outline"
            loading={exportData.isPending}
            onPress={() =>
              void exportData.mutateAsync().catch((err: unknown) => setError(errorText(t, err)))
            }
          >
            {t("settings:data.export")}
          </Button>
        </Box>
      </RowGroup>
      {error ? <Text color="destructive">{error}</Text> : null}
    </ScrollScreen>
  );
}
