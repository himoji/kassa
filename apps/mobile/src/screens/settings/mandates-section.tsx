import { MandatePeriod, toMinor, type MandateDto } from "@kassa/shared";
import { useMemo, useState } from "react";

import { useCreateMandate, useMandates, usePayees, useRevokeMandate } from "@/api/hooks/payees";
import { RowGroup } from "@/components/row-group";
import { Countdown } from "@/components/kassa/countdown";
import { errorText } from "@/components/kassa/error-text";
import { SettingPicker } from "@/components/kassa/native-controls";
import { QueryView } from "@/components/kassa/query-view";
import { StatusChip } from "@/components/kassa/status-chip";
import { Box, Button, Input, Sheet, Text, toast } from "@/components/ui";
import { MANDATE_CATEGORIES } from "@/lib/categories";
import { confirm } from "@/lib/confirm";
import { useFormat } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { useKassaT } from "@/lib/i18n";
import { PasskeyCancelledError } from "@/lib/passkey-errors";

function MandateItem({ mandate, payeeName }: { mandate: MandateDto; payeeName: string }) {
  const t = useKassaT();
  const f = useFormat();
  const revoke = useRevokeMandate();
  const tone =
    mandate.status === "ACTIVE" ? "positive" : mandate.status === "REVOKED" ? "neutral" : "warning";

  const onRevoke = async () => {
    const ok = await confirm({
      title: t("settings:mandates.revokeTitle"),
      message: t("settings:mandates.revokeBody"),
      confirmLabel: t("settings:mandates.revoke"),
      cancelLabel: t("common:cancel"),
      destructive: true,
    });
    if (!ok) return;
    try {
      await revoke.mutateAsync(mandate.id);
      haptics.warning();
      toast.show({ title: t("settings:mandates.revoked"), kind: "success" });
    } catch (err) {
      haptics.error();
      toast.show({ title: errorText(t, err), kind: "error" });
    }
  };

  return (
    <Box p={4} gap={2}>
      <Box row justify="between" align="center" gap={2}>
        <Text weight="semibold" style={{ flexShrink: 1 }}>
          {payeeName}
        </Text>
        <StatusChip tone={tone} label={t(`settings:mandates.status.${mandate.status}`)} />
      </Box>
      <Text variant="caption">
        {t("settings:mandates.scope", {
          perPayment: f.money(mandate.maxPerPaymentMinor, mandate.currency),
          perPeriod: f.money(mandate.maxPerPeriodMinor, mandate.currency),
          period: t(`settings:mandates.period.${mandate.period}`),
          categories: mandate.categories
            .map((c) => t(`common:category.${c}`, { defaultValue: c }))
            .join(", "),
        })}
      </Text>
      <Text variant="caption">
        {t("settings:mandates.used", {
          amount: f.money(mandate.usedThisPeriodMinor, mandate.currency),
        })}
      </Text>
      {mandate.status === "PENDING_EFFECTIVE" ? (
        <Countdown until={mandate.effectiveAt} prefixKey="settings:effectiveIn" />
      ) : null}
      <Text variant="caption" selectable>
        {t("settings:mandates.hash", { hash: mandate.mandateHash.slice(0, 8) })}
      </Text>
      {mandate.status !== "REVOKED" ? (
        <Button
          variant="destructive"
          size="sm"
          onPress={() => void onRevoke()}
          loading={revoke.isPending}
        >
          {t("settings:mandates.revoke")}
        </Button>
      ) : null}
    </Box>
  );
}

function CreateMandateSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const t = useKassaT();
  const payees = usePayees().data?.payees ?? [];
  const eligible = payees.filter((p) => p.status === "VERIFIED");
  const create = useCreateMandate();
  const [payeeId, setPayeeId] = useState<string>("");
  const [category, setCategory] = useState<string>(MANDATE_CATEGORIES[0]);
  const [period, setPeriod] = useState<MandatePeriod>("MONTH");
  const [perPayment, setPerPayment] = useState("");
  const [perPeriod, setPerPeriod] = useState("");
  const [error, setError] = useState<string | null>(null);
  const payee = eligible.find((p) => p.id === payeeId) ?? eligible[0];

  const submit = async () => {
    if (!payee) return;
    setError(null);
    let maxPerPaymentMinor: number;
    let maxPerPeriodMinor: number;
    try {
      // String -> minor units without float maths (shared toMinor, ISO 4217 exponent).
      maxPerPaymentMinor = toMinor(perPayment.replace(",", "."), payee.currency);
      maxPerPeriodMinor = toMinor(perPeriod.replace(",", "."), payee.currency);
    } catch {
      setError(t("settings:mandates.invalidAmount"));
      return;
    }
    if (maxPerPaymentMinor <= 0 || maxPerPeriodMinor < maxPerPaymentMinor) {
      setError(t("settings:mandates.invalidAmount"));
      return;
    }
    try {
      await create.mutateAsync({
        payeeIds: [payee.id],
        categories: [category],
        currency: payee.currency,
        maxPerPaymentMinor,
        maxPerPeriodMinor,
        period,
        validUntil: null,
      });
      haptics.success();
      toast.show({
        title: t("settings:mandates.created"),
        description: t("settings:pendingToastBody"),
      });
      onClose();
    } catch (err) {
      if (err instanceof PasskeyCancelledError) return;
      haptics.error();
      setError(errorText(t, err));
    }
  };

  return (
    <Sheet visible={visible} onClose={onClose} detents={["full"]}>
      <Box p={5} gap={4}>
        <Text variant="heading">{t("settings:mandates.newTitle")}</Text>
        <Text variant="caption">{t("settings:mandates.newBody")}</Text>
        {eligible.length === 0 ? (
          <Text>{t("settings:mandates.noVerifiedPayees")}</Text>
        ) : (
          <>
            <SettingPicker
              label={t("settings:mandates.payee")}
              value={payee?.id ?? ""}
              options={eligible.map((p) => ({ value: p.id, label: p.name }))}
              onChange={setPayeeId}
            />
            <SettingPicker
              label={t("settings:mandates.category")}
              value={category}
              options={MANDATE_CATEGORIES.map((c) => ({
                value: c,
                label: t(`common:category.${c}`),
              }))}
              onChange={setCategory}
            />
            <SettingPicker
              label={t("settings:mandates.periodLabel")}
              value={period}
              options={MandatePeriod.options.map((p) => ({
                value: p,
                label: t(`settings:mandates.period.${p}`),
              }))}
              onChange={setPeriod}
            />
            <Input
              label={t("settings:mandates.perPayment", { currency: payee?.currency ?? "" })}
              value={perPayment}
              onChangeText={setPerPayment}
              keyboardType="decimal-pad"
            />
            <Input
              label={t("settings:mandates.perPeriod", { currency: payee?.currency ?? "" })}
              value={perPeriod}
              onChangeText={setPerPeriod}
              keyboardType="decimal-pad"
            />
            {error ? <Text color="destructive">{error}</Text> : null}
            <Button size="lg" onPress={() => void submit()} loading={create.isPending}>
              {t("settings:mandates.signCreate")}
            </Button>
          </>
        )}
        <Button variant="ghost" onPress={onClose}>
          {t("common:cancel")}
        </Button>
      </Box>
    </Sheet>
  );
}

/** Mandates: create needs a passkey (and 24 h, I8); revoke is instant. */
export function MandatesSection() {
  const t = useKassaT();
  const mandates = useMandates();
  const payees = usePayees().data?.payees;
  const names = useMemo(() => new Map(payees?.map((p) => [p.id, p.name]) ?? []), [payees]);
  const [creating, setCreating] = useState(false);

  return (
    <>
      <QueryView query={mandates} skeletonRows={1}>
        {(m) => (
          <RowGroup title={t("settings:mandates.title")} footer={t("settings:mandates.footer")}>
            {m.mandates.length === 0 ? (
              <Box p={4}>
                <Text variant="caption">{t("settings:mandates.empty")}</Text>
              </Box>
            ) : null}
            {m.mandates.map((mandate) => (
              <MandateItem
                key={mandate.id}
                mandate={mandate}
                payeeName={mandate.payeeIds
                  .map((id) => names.get(id) ?? t("settings:mandates.unknownPayee"))
                  .join(", ")}
              />
            ))}
            <Box p={3}>
              <Button variant="outline" onPress={() => setCreating(true)}>
                {t("settings:mandates.new")}
              </Button>
            </Box>
          </RowGroup>
        )}
      </QueryView>
      <CreateMandateSheet visible={creating} onClose={() => setCreating(false)} />
    </>
  );
}
