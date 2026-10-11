/**
 * handoff/[paymentId] (spec §11 Handoff, A5). The server compares the QR's payee name with the
 * verified payee (normalised fuzzy match >= 0.92). On QR_PAYEE_MISMATCH this screen shows a
 * warning and neither the QR nor any pay button - there is nothing to pay from here.
 */
import { useLocalSearchParams } from "expo-router";
import QRCode from "react-native-qrcode-svg";
import { View } from "react-native";

import { useHandoff } from "@/api/hooks/records";
import { SimulatedBadge } from "@/components/kassa/badges";
import { QueryView } from "@/components/kassa/query-view";
import { ReasonCodeList } from "@/components/kassa/reason-codes";
import { ScrollScreen } from "@/components/kassa/scroll-screen";
import { StatusChip } from "@/components/kassa/status-chip";
import { Box, Button, Card, Icon, Text } from "@/components/ui";
import { openUrl } from "@/lib/browser";
import { useFormat } from "@/lib/format";
import { useKassaT } from "@/lib/i18n";

export function HandoffScreen() {
  const t = useKassaT();
  const f = useFormat();
  const { paymentId = "" } = useLocalSearchParams<{ paymentId: string }>();
  const handoff = useHandoff(paymentId);

  return (
    <ScrollScreen onRefresh={() => void handoff.refetch()} refreshing={handoff.isRefetching}>
      <QueryView query={handoff} skeletonRows={4}>
        {(h) => {
          const mismatch = h.check === "QR_PAYEE_MISMATCH";
          return (
            <Box gap={5}>
              <SimulatedBadge />
              <Box gap={1} style={{ alignItems: "center" }}>
                <Text variant="title" style={{ fontVariant: ["tabular-nums"] }}>
                  {f.money(h.amountMinor, h.currency)}
                </Text>
              </Box>

              <Card>
                <Box gap={3}>
                  <Text weight="semibold">{t("handoff:nameCheck")}</Text>
                  <Box gap={1}>
                    <Text variant="caption">{t("handoff:verifiedPayee")}</Text>
                    <Text selectable>{h.verifiedPayeeName}</Text>
                  </Box>
                  <Box gap={1}>
                    <Text variant="caption">{t("handoff:qrPayee")}</Text>
                    <Text selectable testID="handoff-qr-name">
                      {h.qrPayeeName}
                    </Text>
                  </Box>
                  <StatusChip
                    tone={mismatch ? "critical" : "positive"}
                    label={mismatch ? t("handoff:mismatch") : t("handoff:match")}
                    testID="handoff-check"
                  />
                </Box>
              </Card>

              {mismatch ? (
                <Card>
                  <Box gap={3} testID="handoff-mismatch-warning">
                    <Box row gap={2} align="center">
                      <Icon
                        name="exclamationmark.octagon.fill"
                        fallback="report"
                        size={22}
                        color="destructive"
                      />
                      <Text weight="semibold" color="destructive" style={{ flexShrink: 1 }}>
                        {t("handoff:mismatchTitle")}
                      </Text>
                    </Box>
                    <Text>{t("handoff:mismatchBody")}</Text>
                    <ReasonCodeList
                      codes={h.reasonCodes.length > 0 ? h.reasonCodes : ["QR_PAYEE_MISMATCH"]}
                    />
                  </Box>
                </Card>
              ) : (
                <Box gap={4} style={{ alignItems: "center" }}>
                  <View
                    accessible
                    accessibilityRole="image"
                    accessibilityLabel={t("handoff:qrA11y", { name: h.qrPayeeName })}
                    style={{ padding: 16, backgroundColor: "#ffffff", borderRadius: 16 }}
                  >
                    <QRCode value={h.qrPayload} size={220} />
                  </View>
                  <Text variant="caption" align="center">
                    {t("handoff:scanHint")}
                  </Text>
                  {h.walletUrl ? (
                    <Button size="lg" onPress={() => void openUrl(h.walletUrl!)}>
                      {t("handoff:openWallet")}
                    </Button>
                  ) : null}
                </Box>
              )}
            </Box>
          );
        }}
      </QueryView>
    </ScrollScreen>
  );
}
