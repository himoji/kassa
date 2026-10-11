import type { PayeeDto } from "@kassa/shared";

import { useKassaT } from "@/lib/i18n";

import { useRemaining } from "./countdown";
import { StatusChip } from "./status-chip";

/** Verified / Cooling (with live countdown on the demo clock) / Blocked - label + colour + icon. */
export function PayeeStatusChip({ payee }: { payee: Pick<PayeeDto, "status" | "coolingUntil"> }) {
  const t = useKassaT();
  const remaining = useRemaining(payee.status === "COOLING" ? payee.coolingUntil : null);
  if (payee.status === "VERIFIED")
    return <StatusChip tone="positive" label={t("payees:status.VERIFIED")} />;
  if (payee.status === "BLOCKED")
    return <StatusChip tone="critical" label={t("payees:status.BLOCKED")} />;
  return (
    <StatusChip
      tone="warning"
      label={remaining ? t("payees:coolingFor", { remaining }) : t("payees:status.COOLING")}
    />
  );
}
