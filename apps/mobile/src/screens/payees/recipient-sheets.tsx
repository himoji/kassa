import { DemoStateResponse, suggestedReference, type PayeeDto } from "@kassa/shared";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { api } from "@/api/client";
import { useCreateObligation, useUpdatePayeeDetails } from "@/api/hooks/payees";
import { errorText } from "@/components/kassa/error-text";
import { MoneyInput } from "@/components/kassa/money-input";
import { Segmented } from "@/components/kassa/segmented";
import { Box, Button, Input, Sheet, Text, toast } from "@/components/ui";
import { haptics } from "@/lib/haptics";
import { useKassaT } from "@/lib/i18n";

import {
  detailsToForm,
  formToDetails,
  RecipientDetailsFields,
  type DetailsForm,
} from "./recipient-fields";

/** Edit a recipient's details. Where the money goes never changes here, so there is no new cooling period. */
export function EditDetailsSheet(props: {
  payee: PayeeDto;
  visible: boolean;
  onClose: () => void;
}) {
  // The form mounts when the sheet opens, so it always starts from the saved details.
  return (
    <Sheet visible={props.visible} onClose={props.onClose} detents={["full"]}>
      {props.visible ? <EditDetailsForm payee={props.payee} onClose={props.onClose} /> : null}
    </Sheet>
  );
}

function EditDetailsForm({ payee, onClose }: { payee: PayeeDto; onClose: () => void }) {
  const t = useKassaT();
  const update = useUpdatePayeeDetails(payee.id);
  const [form, setForm] = useState<DetailsForm>(detailsToForm(payee.details));
  const [showErrors, setShowErrors] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const check = formToDetails(payee.category, form);
  const save = async () => {
    setShowErrors(true);
    if (!check.ok) return haptics.error();
    try {
      await update.mutateAsync(check.details);
      haptics.success();
      toast.show({ title: t("payees:actions.saved"), kind: "success" });
      onClose();
    } catch (err) {
      haptics.error();
      setError(errorText(t, err));
    }
  };

  return (
    <Box p={5} gap={4}>
      <Box gap={1}>
        <Text variant="heading">{t("payees:edit.title")}</Text>
        <Text variant="caption">{t("payees:edit.note")}</Text>
      </Box>
      <RecipientDetailsFields
        category={payee.category}
        form={form}
        onChange={(patch) => setForm((prev) => ({ ...prev, ...patch }))}
        errorFor={(key) =>
          showErrors && !check.ok && check.field === key
            ? t(`payees:add.errors.${check.code}`)
            : undefined
        }
      />
      {error ? <Text color="destructive">{error}</Text> : null}
      <Button size="lg" onPress={() => void save()} loading={update.isPending}>
        {t("payees:edit.save")}
      </Button>
      <Button variant="ghost" onPress={onClose}>
        {t("common:cancel")}
      </Button>
    </Box>
  );
}

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** The next date on `day` of the month (today counts), or a week from today when there is no due day. */
export function firstDueDate(today: Date, day: number | undefined): string {
  if (!day) return iso(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 7));
  const month = day >= today.getDate() ? today.getMonth() : today.getMonth() + 1;
  return iso(new Date(today.getFullYear(), month, day));
}

/**
 * "Today" as the server sees it: the demo clock when the server runs one (GET /demo/clock, demo builds only), so
 * a default due date is never already past on a server whose clock was moved forward; otherwise the device date.
 */
function useServerToday(): Date {
  const clock = useQuery({
    queryKey: ["demo", "clock"],
    queryFn: ({ signal }) => api.request("/demo/clock", { schema: DemoStateResponse, signal }),
    retry: false,
    staleTime: 60_000,
  });
  return clock.data ? new Date(clock.data.now) : new Date();
}

/**
 * Set up a schedule (rent, a bill, wages, monthly support): a bill Kassa plans and proposes when due, through the same
 * rules and passkey as every payment (or inside a signed mandate).
 */
export function ScheduleSheet({
  payee,
  visible,
  onClose,
}: {
  payee: PayeeDto;
  visible: boolean;
  onClose: () => void;
}) {
  const todayIso = iso(useServerToday());
  // Mounted when the sheet opens (and again if the server's date arrives late), so it starts empty each time.
  return (
    <Sheet visible={visible} onClose={onClose} detents={["full"]}>
      {visible ? (
        <ScheduleForm key={todayIso} payee={payee} todayIso={todayIso} onClose={onClose} />
      ) : null}
    </Sheet>
  );
}

function ScheduleForm({
  payee,
  todayIso,
  onClose,
}: {
  payee: PayeeDto;
  todayIso: string;
  onClose: () => void;
}) {
  const t = useKassaT();
  const create = useCreateObligation();
  const dueDay = payee.details?.category === "RENT" ? payee.details.dueDay : undefined;
  const [amountMinor, setAmountMinor] = useState<number | null>(null);
  const [dueDate, setDueDate] = useState(firstDueDate(new Date(`${todayIso}T12:00:00`), dueDay));
  const [recurrence, setRecurrence] = useState<"MONTHLY" | "ONCE">(
    payee.category === "TUITION" ? "ONCE" : "MONTHLY"
  );
  const [reference, setReference] = useState(suggestedReference(payee.details));
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    if (!amountMinor) return setError(t("wallet:errors.AMOUNT"));
    // The server checks the date against its own clock (DUE_DATE_PAST).
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return setError(t("payees:schedule.dateInvalid"));
    try {
      await create.mutateAsync({
        payeeId: payee.id,
        amountMinor,
        currency: payee.currency,
        dueDate,
        recurrence,
        ...(reference.trim() ? { reference: reference.trim() } : {}),
      });
      haptics.success();
      toast.show({ title: t("payees:schedule.created"), kind: "success" });
      onClose();
    } catch (err) {
      haptics.error();
      setError(errorText(t, err));
    }
  };

  return (
    <Box p={5} gap={4}>
      <Box gap={1}>
        <Text variant="heading">{t("payees:schedule.title")}</Text>
        <Text variant="caption">{t("payees:schedule.body")}</Text>
      </Box>
      <Box gap={2}>
        <Text variant="label">{t("payees:schedule.amount")}</Text>
        <MoneyInput
          testID="schedule-amount"
          valueMinor={amountMinor}
          currency={payee.currency}
          onChange={setAmountMinor}
          accessibilityLabel={t("payees:schedule.amount")}
        />
      </Box>
      <Input
        label={t("payees:schedule.firstDue")}
        value={dueDate}
        onChangeText={setDueDate}
        placeholder="2026-11-01"
        testID="schedule-due-date"
      />
      <Segmented
        value={recurrence}
        onChange={setRecurrence}
        options={[
          { value: "MONTHLY", label: t("payees:schedule.monthly") },
          { value: "ONCE", label: t("payees:schedule.once") },
        ]}
      />
      <Input label={t("payees:schedule.reference")} value={reference} onChangeText={setReference} />
      {error ? <Text color="destructive">{error}</Text> : null}
      <Button size="lg" onPress={() => void submit()} loading={create.isPending}>
        {t("payees:schedule.create")}
      </Button>
      <Button variant="ghost" onPress={onClose}>
        {t("common:cancel")}
      </Button>
    </Box>
  );
}
