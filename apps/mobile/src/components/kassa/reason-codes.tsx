import { HARD_REFUSE_CODES, type ReasonCode } from "@kassa/shared";
import { router } from "expo-router";
import { View } from "react-native";

import { Button, Text } from "@/components/ui";
import { useKassaT } from "@/lib/i18n";

import { StatusChip } from "./status-chip";

const HARD = new Set<string>(HARD_REFUSE_CODES);

export function reasonTone(code: ReasonCode) {
  if (HARD.has(code) || code === "QR_PAYEE_MISMATCH" || code === "NONCE_USED") return "critical";
  if (code === "PAYEE_COOLING" || code === "LOOSEN_PENDING" || code.startsWith("HANDOFF")) {
    return "warning";
  }
  return "info";
}

/** Machine reason codes in plain language (translated client-side; the server sends codes only). */
export function ReasonCodeList({ codes }: { codes: readonly ReasonCode[] }) {
  const t = useKassaT();
  if (codes.length === 0) return null;
  return (
    <View style={{ gap: 8 }}>
      {codes.map((code) => (
        <View
          key={code}
          style={{ gap: 4 }}
          accessible
          accessibilityLabel={`${t(`reasonCodes:${code}.label`)}. ${t(`reasonCodes:${code}.text`)}`}
        >
          <StatusChip tone={reasonTone(code)} label={t(`reasonCodes:${code}.label`)} />
          <Text variant="caption">{t(`reasonCodes:${code}.text`)}</Text>
          {code === "INSUFFICIENT_FUNDS" ? (
            <Button
              size="sm"
              variant="secondary"
              style={{ alignSelf: "flex-start" }}
              onPress={() => router.push("/add-money")}
            >
              {t("home:addMoney")}
            </Button>
          ) : null}
          {code === "KYC_REQUIRED" ? (
            <Button
              size="sm"
              variant="secondary"
              style={{ alignSelf: "flex-start" }}
              onPress={() => router.push("/identity-check")}
            >
              {t("kyc:openFromReason")}
            </Button>
          ) : null}
        </View>
      ))}
    </View>
  );
}
