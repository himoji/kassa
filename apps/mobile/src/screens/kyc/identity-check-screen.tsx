import {
  KycStartRequest,
  type KycCheckDto,
  type KycDocumentType,
  type KycLivenessResult,
  type KycStatus,
} from "@kassa/shared";
import { useState } from "react";

import { useKyc, useStartKyc } from "@/api/hooks/kyc";
import { useMe } from "@/api/hooks/me";
import { SimulatedBadge } from "@/components/kassa/badges";
import { errorText } from "@/components/kassa/error-text";
import { QueryView } from "@/components/kassa/query-view";
import { ScrollScreen } from "@/components/kassa/scroll-screen";
import { Segmented } from "@/components/kassa/segmented";
import { StatusChip } from "@/components/kassa/status-chip";
import { RowGroup } from "@/components/row-group";
import { Box, Button, Card, Input, Row, Text } from "@/components/ui";
import { useFormat } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { useKassaT } from "@/lib/i18n";
import type { StatusTone } from "@/theme/status";

const DOC_TYPES: readonly KycDocumentType[] = [
  "PASSPORT",
  "ID_CARD",
  "DRIVING_LICENCE",
  "RESIDENCE_PERMIT",
];
const LIVENESS: readonly KycLivenessResult[] = ["PASS", "FAIL", "INCONCLUSIVE"];

const TONE: Record<KycStatus, StatusTone> = {
  NONE: "neutral",
  VERIFIED: "positive",
  REVIEW: "warning",
  REJECTED: "critical",
};

/** A made-up document for the sandbox: valid for years, an adult's date of birth, the account's own name. */
export function sampleDocument(displayName: string, today = new Date()) {
  const y = today.getUTCFullYear();
  return {
    type: "PASSPORT" as const,
    number: "TX1234567",
    country: "KZ",
    fullName: displayName,
    dateOfBirth: `${y - 25}-04-17`,
    expiresOn: `${y + 5}-01-31`,
  };
}

export function KycLatestCheck({ check }: { check: KycCheckDto }) {
  const t = useKassaT();
  const f = useFormat();
  const type = t(`kyc:docType.${check.documentType}`);
  return (
    <RowGroup title={t("kyc:latest")}>
      <Row
        title={t("kyc:documentTitle")}
        subtitle={
          check.documentLast4
            ? t("kyc:documentSummary", {
                type,
                country: check.documentCountry,
                last4: check.documentLast4,
              })
            : t("kyc:documentSummaryNoNumber", { type, country: check.documentCountry })
        }
      />
      <Row
        title={t("kyc:checkedAt")}
        trailing={<Text selectable>{f.dateTime(check.checkedAt)}</Text>}
      />
      {check.reasonCodes.map((code) => (
        <Row key={code} title={t(`kyc:reason.${code}`)} />
      ))}
    </RowGroup>
  );
}

/**
 * Identity check (KYC), simulated: a fictitious document plus a simulated liveness step. The server keeps only the
 * outcome, the document type and country, and the last 4 characters of the number.
 */
export function IdentityCheckScreen() {
  const t = useKassaT();
  const f = useFormat();
  const me = useMe();
  const kyc = useKyc();
  const start = useStartKyc();

  const [type, setType] = useState<KycDocumentType>("PASSPORT");
  const [number, setNumber] = useState("");
  const [country, setCountry] = useState("");
  const [fullName, setFullName] = useState("");
  const [dateOfBirth, setDateOfBirth] = useState("");
  const [expiresOn, setExpiresOn] = useState("");
  const [livenessChoice, setLivenessChoice] = useState<KycLivenessResult>("PASS");
  const [liveness, setLiveness] = useState<KycLivenessResult | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const fillSample = () => {
    const s = sampleDocument(me.data?.displayName ?? "");
    setType(s.type);
    setNumber(s.number);
    setCountry(s.country);
    setFullName(s.fullName);
    setDateOfBirth(s.dateOfBirth);
    setExpiresOn(s.expiresOn);
    setMessage(null);
  };

  const submit = async () => {
    setMessage(null);
    if (!liveness) {
      setMessage(t("kyc:livenessNeeded"));
      return;
    }
    const body = KycStartRequest.safeParse({
      document: {
        type,
        number,
        country: country.trim().toUpperCase(),
        fullName,
        dateOfBirth: dateOfBirth.trim(),
        expiresOn: expiresOn.trim(),
      },
      liveness: { result: liveness },
    });
    if (!body.success) {
      setMessage(t("kyc:invalid"));
      return;
    }
    try {
      const r = await start.mutateAsync(body.data);
      if (r.outcome === "VERIFIED") haptics.success();
      else haptics.warning();
      setMessage(t(`kyc:result.${r.outcome}`));
      setLiveness(null);
    } catch (err) {
      haptics.error();
      setMessage(errorText(t, err));
    }
  };

  return (
    <ScrollScreen
      onRefresh={() => void kyc.refetch()}
      refreshing={kyc.isRefetching}
      testID="identity-check"
    >
      <QueryView query={kyc} skeletonRows={3}>
        {(data) => (
          <>
            <Card>
              <Box gap={3}>
                <Box row justify="between" align="center" gap={2}>
                  <StatusChip
                    tone={TONE[data.status]}
                    label={t(`kyc:status.${data.status}`)}
                    testID="kyc-status"
                  />
                  <SimulatedBadge />
                </Box>
                <Text variant="caption">{t(`kyc:statusText.${data.status}`)}</Text>
                <Text variant="caption" color="mutedForeground">
                  {t("kyc:intro", { amount: f.money(data.thresholdHomeMinor, data.homeCurrency) })}
                </Text>
              </Box>
            </Card>
            {data.latest ? <KycLatestCheck check={data.latest} /> : null}
          </>
        )}
      </QueryView>

      <RowGroup title={t("kyc:documentTitle")} footer={t("kyc:documentFooter")}>
        <Card>
          <Box gap={4}>
            <Text variant="label">{t("kyc:fields.type")}</Text>
            <Segmented
              options={DOC_TYPES.map((d) => ({ value: d, label: t(`kyc:docType.${d}`) }))}
              value={type}
              onChange={setType}
            />
            <Input
              label={t("kyc:fields.number")}
              placeholder={t("kyc:fields.numberPlaceholder")}
              value={number}
              onChangeText={setNumber}
              autoCapitalize="characters"
              autoCorrect={false}
              maxLength={40}
              testID="kyc-number"
            />
            <Input
              label={t("kyc:fields.country")}
              placeholder={t("kyc:fields.countryPlaceholder")}
              value={country}
              onChangeText={(v) =>
                setCountry(
                  v
                    .replace(/[^A-Za-z]/g, "")
                    .slice(0, 2)
                    .toUpperCase()
                )
              }
              autoCapitalize="characters"
              autoCorrect={false}
              maxLength={2}
              testID="kyc-country"
            />
            <Input
              label={t("kyc:fields.fullName")}
              value={fullName}
              onChangeText={setFullName}
              autoCorrect={false}
              maxLength={140}
              testID="kyc-name"
            />
            <Input
              label={t("kyc:fields.dateOfBirth")}
              placeholder={t("kyc:fields.datePlaceholder")}
              value={dateOfBirth}
              onChangeText={setDateOfBirth}
              keyboardType="numbers-and-punctuation"
              autoCorrect={false}
              maxLength={10}
              testID="kyc-dob"
            />
            <Input
              label={t("kyc:fields.expiresOn")}
              placeholder={t("kyc:fields.datePlaceholder")}
              value={expiresOn}
              onChangeText={setExpiresOn}
              keyboardType="numbers-and-punctuation"
              autoCorrect={false}
              maxLength={10}
              testID="kyc-expires"
            />
            <Button variant="secondary" size="sm" onPress={fillSample}>
              {t("kyc:sample")}
            </Button>
          </Box>
        </Card>
      </RowGroup>

      <RowGroup title={t("kyc:livenessTitle")} footer={t("kyc:livenessFooter")}>
        <Card>
          <Box gap={3}>
            <Box row justify="between" align="center" gap={2}>
              <Text variant="label">{t("kyc:simulateLiveness")}</Text>
              <SimulatedBadge />
            </Box>
            <Segmented
              options={LIVENESS.map((l) => ({ value: l, label: t(`kyc:liveness.${l}`) }))}
              value={livenessChoice}
              onChange={(v) => {
                setLivenessChoice(v);
                setLiveness(null);
              }}
            />
            <Button
              variant="outline"
              onPress={() => {
                haptics.selection();
                setLiveness(livenessChoice);
                setMessage(null);
              }}
            >
              {t("kyc:simulateLiveness")}
            </Button>
            {liveness ? (
              <Text variant="caption" testID="kyc-liveness-done">
                {t("kyc:livenessDone", { result: t(`kyc:liveness.${liveness}`) })}
              </Text>
            ) : null}
          </Box>
        </Card>
      </RowGroup>

      {message ? (
        <Text testID="kyc-message" align="center">
          {message}
        </Text>
      ) : null}
      <Button size="lg" onPress={() => void submit()} loading={start.isPending}>
        {t("kyc:submit")}
      </Button>
      <Text variant="caption" color="mutedForeground" align="center">
        {t("kyc:privacy")} {t("kyc:partner")}
      </Text>
    </ScrollScreen>
  );
}
