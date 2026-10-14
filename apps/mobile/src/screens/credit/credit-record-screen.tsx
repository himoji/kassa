import { CreditRecordItem, type CreditRecordExportResponse } from "@kassa/shared";
import { router } from "expo-router";
import { useState } from "react";
import { Linking } from "react-native";

import { useExportCreditRecord } from "@/api/hooks/records";
import { SimulatedBadge } from "@/components/kassa/badges";
import { errorText } from "@/components/kassa/error-text";
import { Segmented } from "@/components/kassa/segmented";
import { ScrollScreen } from "@/components/kassa/scroll-screen";
import { SettingSwitch } from "@/components/kassa/native-controls";
import { RowGroup } from "@/components/row-group";
import { Box, Button, Card, Text, toast } from "@/components/ui";
import { haptics } from "@/lib/haptics";
import { useKassaT } from "@/lib/i18n";
import { sharePdf, shareLink, type ShareOutcome } from "@/lib/share-record";

type Period = "3m" | "6m" | "12m";

const PERIOD_MONTHS: Record<Period, number> = { "3m": 3, "6m": 6, "12m": 12 };

/** ISO `YYYY-MM-DD` range: today back N calendar months (UTC, so the day never shifts). */
function isoRange(months: number): { from: string; to: string } {
  const today = new Date();
  const from = new Date(today.getTime());
  from.setUTCMonth(from.getUTCMonth() - months);
  return { from: from.toISOString().slice(0, 10), to: today.toISOString().slice(0, 10) };
}

/** Credit record export (spec §8): choose period and items, export a verifiable bundle. */
export function CreditRecordScreen() {
  const t = useKassaT();
  const exportRecord = useExportCreditRecord();
  const [period, setPeriod] = useState<Period>("6m");
  const [items, setItems] = useState<Set<CreditRecordItem>>(
    () => new Set(CreditRecordItem.options)
  );
  const [result, setResult] = useState<CreditRecordExportResponse | null>(null);

  const selected = CreditRecordItem.options.filter((item) => items.has(item));

  const setItem = (item: CreditRecordItem, on: boolean) => {
    setItems((prev) => {
      const next = new Set(prev);
      if (on) next.add(item);
      else next.delete(item);
      return next;
    });
  };

  const onExport = async () => {
    try {
      const res = await exportRecord.mutateAsync({
        ...isoRange(PERIOD_MONTHS[period]),
        items: selected,
      });
      setResult(res);
      haptics.success();
    } catch (err) {
      haptics.error();
      toast.show({ title: errorText(t, err), kind: "error" });
    }
  };

  const [sharing, setSharing] = useState<"link" | "pdf" | null>(null);

  const afterShare = (outcome: ShareOutcome) => {
    if (outcome === "shared") haptics.success();
    else if (outcome === "downloaded") toast.show({ title: t("credit:pdfDownloaded") });
    else if (outcome === "failed") toast.show({ title: t("credit:shareFailed"), kind: "error" });
  };

  const onShare = async (r: CreditRecordExportResponse) => {
    setSharing("link");
    afterShare(
      await shareLink({
        url: r.verifyUrl,
        title: t("credit:shareTitle"),
        message: t("credit:shareMessage"),
        copiedToast: t("credit:linkCopied"),
      })
    );
    setSharing(null);
  };

  const onSharePdf = async (r: CreditRecordExportResponse) => {
    setSharing("pdf");
    afterShare(
      await sharePdf({
        url: r.pdfUrl,
        fileName: `kassa-credit-record-${r.verifyId}.pdf`,
        title: t("credit:shareTitle"),
      })
    );
    setSharing(null);
  };

  const onOpenPdf = (pdfUrl: string) => {
    void Linking.openURL(pdfUrl).catch((err: unknown) =>
      toast.show({ title: errorText(t, err), kind: "error" })
    );
  };

  return (
    <ScrollScreen>
      <Box gap={3}>
        <SimulatedBadge />
        <Text variant="caption">{t("credit:intro")}</Text>
      </Box>

      <Segmented
        value={period}
        onChange={setPeriod}
        options={[
          { value: "3m", label: t("credit:period.3m") },
          { value: "6m", label: t("credit:period.6m") },
          { value: "12m", label: t("credit:period.12m") },
        ]}
      />

      <RowGroup title={t("credit:itemsTitle")}>
        {CreditRecordItem.options.map((item) => (
          <SettingSwitch
            key={item}
            label={t(`credit:item.${item}`)}
            value={items.has(item)}
            onChange={(on) => setItem(item, on)}
          />
        ))}
      </RowGroup>

      <Button
        size="lg"
        disabled={selected.length === 0}
        loading={exportRecord.isPending}
        onPress={() => void onExport()}
      >
        {t("credit:export")}
      </Button>

      {result ? (
        <Card>
          <Box gap={3}>
            <Text weight="semibold">{t("credit:exported")}</Text>
            <Text variant="caption" selectable>
              {t("credit:hash", { hash: result.sha256.slice(0, 16) })}
            </Text>
            <Button loading={sharing === "link"} onPress={() => void onShare(result)}>
              {t("credit:share")}
            </Button>
            <Button
              variant="outline"
              loading={sharing === "pdf"}
              onPress={() => void onSharePdf(result)}
            >
              {t("credit:sharePdf")}
            </Button>
            <Button variant="outline" onPress={() => router.push(`/verify/${result.verifyId}`)}>
              {t("credit:openVerify")}
            </Button>
            <Button variant="ghost" onPress={() => onOpenPdf(result.pdfUrl)}>
              {t("credit:openPdf")}
            </Button>
          </Box>
        </Card>
      ) : null}
    </ScrollScreen>
  );
}
