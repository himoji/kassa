import { useEffect, useState } from "react";
import { View } from "react-native";
import QRCode from "react-native-qrcode-svg";

import { usePairStart } from "@/api/hooks/pair";
import { errorText } from "@/components/kassa/error-text";
import { ScrollScreen } from "@/components/kassa/scroll-screen";
import { Box, Button, Text, toast } from "@/components/ui";
import { haptics } from "@/lib/haptics";
import { useKassaT } from "@/lib/i18n";

/** m:ss for the remaining milliseconds (never negative). */
export function formatCountdown(ms: number): { minutes: number; seconds: string } {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return { minutes: Math.floor(total / 60), seconds: String(total % 60).padStart(2, "0") };
}

function Countdown({ until, onExpired }: { until: number; onExpired: () => void }) {
  const t = useKassaT();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const remaining = until - now;
  useEffect(() => {
    if (remaining <= 0) onExpired();
  }, [remaining, onExpired]);
  const { minutes, seconds } = formatCountdown(remaining);
  return (
    <Text variant="caption" style={{ fontVariant: ["tabular-nums"] }} testID="pair-countdown">
      {t("lite:pairDevice.expiresIn", {
        time: t("lite:pairDevice.countdown", { minutes, seconds }),
      })}
    </Text>
  );
}

/**
 * Settings → "Pair KassaLite": mint a single-use code (passkey-gated), show it as a QR code (`pairUrl`) and
 * as 8 big characters, valid for 2 minutes. After that only "New code" remains.
 */
export function PairLiteScreen() {
  const t = useKassaT();
  const start = usePairStart();
  const [expired, setExpired] = useState(false);
  const pairing = start.data;

  const create = async () => {
    setExpired(false);
    try {
      await start.mutateAsync();
      haptics.success();
    } catch (err) {
      haptics.error();
      toast.show({ title: errorText(t, err), kind: "error" });
    }
  };

  const active = pairing && !expired;
  return (
    <ScrollScreen>
      <Text variant="caption">{t("lite:pairDevice.intro")}</Text>
      {active ? (
        <Box gap={4} align="center">
          <View
            accessibilityLabel={t("lite:pairDevice.qrLabel")}
            style={{ padding: 16, backgroundColor: "#ffffff", borderRadius: 16 }}
          >
            <QRCode value={pairing.pairUrl} size={220} />
          </View>
          <Text variant="caption">{t("lite:pairDevice.codeLabel")}</Text>
          <Text
            variant="title"
            selectable
            testID="pair-code"
            style={{
              fontSize: 40,
              lineHeight: 48,
              letterSpacing: 6,
              fontVariant: ["tabular-nums"],
            }}
          >
            {pairing.code}
          </Text>
          <Countdown until={Date.parse(pairing.expiresAt)} onExpired={() => setExpired(true)} />
        </Box>
      ) : (
        <Box gap={3}>
          {pairing && expired ? (
            <Text color="destructive">{t("lite:pairDevice.expired")}</Text>
          ) : null}
          <Button onPress={() => void create()} loading={start.isPending}>
            {pairing ? t("lite:pairDevice.newCode") : t("lite:pairDevice.generate")}
          </Button>
        </Box>
      )}
    </ScrollScreen>
  );
}
