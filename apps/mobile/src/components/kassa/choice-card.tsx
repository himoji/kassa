/**
 * `data-choices` card: the assistant asks the user to pick instead of type (chips, yes/no, an
 * amount stepper or a day picker). A tap answers with the option label as the user's message plus
 * the structured `choice` the server validates against the stored picker. Read-only once answered.
 */
import { currencyExponent, type ChoiceAnswer, type DataChoices } from "@kassa/shared";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { Box, Button, Card, Text, useTheme } from "@/components/ui";
import { useFormat } from "@/lib/format";
import { useKassaT } from "@/lib/i18n";

export interface ChoiceAnswerInput {
  /** The user message text: the option label / formatted amount / date. */
  text: string;
  choice: ChoiceAnswer;
}

export interface ChoiceCardProps {
  part: DataChoices;
  onAnswer: (answer: ChoiceAnswerInput) => void;
  /** True while a reply is in flight: the card cannot answer. */
  disabled?: boolean;
}

const DAY_MS = 86_400_000;

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` shifted by whole days (UTC, so it never skips a day around DST). */
export function shiftDate(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function clamp(value: number, min?: number, max?: number): number {
  let out = value;
  if (max !== undefined) out = Math.min(out, max);
  if (min !== undefined) out = Math.max(out, min);
  return out;
}

/** A picker followed by a user message is answered (also when the server stored no `answer`). */
export function withReplyAnswer(part: DataChoices, answerText: string | undefined): DataChoices {
  if (part.answer || answerText === undefined) return part;
  const picked = answerText.split(", ");
  const optionIds = part.options.filter((o) => picked.includes(o.label)).map((o) => o.id);
  return { ...part, answer: { optionIds, label: answerText } };
}

function Chip({
  label,
  selected,
  disabled,
  onPress,
}: {
  label: string;
  selected?: boolean;
  disabled?: boolean;
  onPress?: () => void;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || !onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: !!selected, disabled: !!disabled }}
      style={{
        minHeight: 40,
        justifyContent: "center",
        paddingHorizontal: 14,
        borderRadius: 20,
        borderCurve: "continuous",
        borderWidth: 1,
        borderColor: selected ? colors.brandAccent : colors.border,
        backgroundColor: selected ? colors.brandAccent : colors.background,
        opacity: disabled && !selected ? 0.5 : 1,
      }}
    >
      <Text style={selected ? { color: "#ffffff" } : undefined}>{label}</Text>
    </Pressable>
  );
}

export function ChoiceCard({ part, onAnswer, disabled }: ChoiceCardProps) {
  const t = useKassaT();
  const f = useFormat();
  const [local, setLocal] = useState<{ label: string; optionIds: string[] } | null>(null);
  const [picked, setPicked] = useState<string[]>([]);

  const answered = part.answer
    ? { label: part.answer.label, optionIds: part.answer.optionIds }
    : local;
  const locked = !!answered || !!disabled;

  const answer = (a: ChoiceAnswerInput, optionIds: string[]) => {
    if (locked) return;
    setLocal({ label: a.text, optionIds });
    onAnswer(a);
  };

  const amountCfg = part.amount;
  const exponent = amountCfg ? currencyExponent(amountCfg.currency) : 0;
  const step = amountCfg?.stepMinor ?? 100 * 10 ** exponent;
  const [minor, setMinor] = useState(() =>
    clamp(
      amountCfg?.defaultMinor ?? amountCfg?.minMinor ?? step,
      amountCfg?.minMinor,
      amountCfg?.maxMinor
    )
  );
  const [dateText, setDateText] = useState(
    () => part.date?.default ?? part.date?.min ?? todayIso()
  );

  const optionById = (id: string) => part.options.find((o) => o.id === id);

  let body;
  if (answered) {
    const selected = answered.optionIds;
    body = (
      <Box gap={2}>
        {part.kind === "choice" || part.kind === "confirm" ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {part.options.map((o) => (
              <Chip key={o.id} label={o.label} selected={selected.includes(o.id)} disabled />
            ))}
          </View>
        ) : null}
        <Text variant="caption">{t("chat:choice.answered", { label: answered.label })}</Text>
      </Box>
    );
  } else if (part.kind === "confirm") {
    body = (
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {part.options.map((o, i) => (
          <Button
            key={o.id}
            variant={i === 0 ? "primary" : "outline"}
            disabled={locked}
            onPress={() =>
              answer({ text: o.label, choice: { id: part.id, optionId: o.id } }, [o.id])
            }
          >
            {o.label}
          </Button>
        ))}
      </View>
    );
  } else if (part.kind === "amount" && amountCfg) {
    const bump = (dir: 1 | -1) =>
      setMinor((m) => clamp(m + dir * step, amountCfg.minMinor, amountCfg.maxMinor));
    const label = f.money(minor, amountCfg.currency);
    body = (
      <Box gap={3}>
        <Box row gap={3} align="center" justify="center">
          <Button
            variant="outline"
            size="icon"
            disabled={locked || (amountCfg.minMinor !== undefined && minor <= amountCfg.minMinor)}
            onPress={() => bump(-1)}
          >
            -
          </Button>
          <Text variant="heading" accessibilityLabel={t("chat:choice.amountA11y")}>
            {label}
          </Text>
          <Button
            variant="outline"
            size="icon"
            disabled={locked || (amountCfg.maxMinor !== undefined && minor >= amountCfg.maxMinor)}
            onPress={() => bump(1)}
          >
            +
          </Button>
        </Box>
        <Button
          disabled={locked}
          onPress={() => answer({ text: label, choice: { id: part.id, value: String(minor) } }, [])}
        >
          {t("chat:choice.confirm")}
        </Button>
      </Box>
    );
  } else if (part.kind === "date") {
    const valid = /^\d{4}-\d{2}-\d{2}$/.test(dateText) && !Number.isNaN(Date.parse(dateText));
    const inRange =
      valid &&
      (part.date?.min === undefined || dateText >= part.date.min) &&
      (part.date?.max === undefined || dateText <= part.date.max);
    const move = (days: number) =>
      setDateText((d) => {
        const next = shiftDate(valid ? d : todayIso(), days);
        if (part.date?.min && next < part.date.min) return part.date.min;
        if (part.date?.max && next > part.date.max) return part.date.max;
        return next;
      });
    body = (
      <Box gap={3}>
        <Box row gap={2} align="center" justify="center" style={{ flexWrap: "wrap" }}>
          <Button variant="outline" size="sm" disabled={locked} onPress={() => move(-7)}>
            {t("chat:choice.weekMinus")}
          </Button>
          <Button variant="outline" size="sm" disabled={locked} onPress={() => move(-1)}>
            {t("chat:choice.dayMinus")}
          </Button>
          <Text variant="heading">{valid ? f.date(dateText, "medium") : dateText}</Text>
          <Button variant="outline" size="sm" disabled={locked} onPress={() => move(1)}>
            {t("chat:choice.dayPlus")}
          </Button>
          <Button variant="outline" size="sm" disabled={locked} onPress={() => move(7)}>
            {t("chat:choice.weekPlus")}
          </Button>
        </Box>
        <Button
          disabled={locked || !inRange}
          onPress={() => answer({ text: dateText, choice: { id: part.id, value: dateText } }, [])}
        >
          {t("chat:choice.confirm")}
        </Button>
      </Box>
    );
  } else {
    const multi = !!part.multi;
    const toggle = (id: string) =>
      setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
    body = (
      <Box gap={3}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {part.options.map((o) => (
            <Chip
              key={o.id}
              label={o.label}
              selected={multi && picked.includes(o.id)}
              disabled={locked}
              onPress={() =>
                multi
                  ? toggle(o.id)
                  : answer({ text: o.label, choice: { id: part.id, optionId: o.id } }, [o.id])
              }
            />
          ))}
        </View>
        {multi ? (
          <Button
            disabled={locked || picked.length === 0}
            onPress={() => {
              const ids = part.options.filter((o) => picked.includes(o.id)).map((o) => o.id);
              const labels = ids.map((id) => optionById(id)!.label).join(", ");
              answer({ text: labels, choice: { id: part.id, optionIds: ids } }, ids);
            }}
          >
            {t("chat:choice.confirm")}
          </Button>
        ) : null}
      </Box>
    );
  }

  return (
    <Card>
      <Box gap={3}>
        <Text weight="semibold">{part.prompt}</Text>
        {body}
        {part.allowOther && !answered ? (
          <Text variant="caption">{t("chat:choice.allowOther")}</Text>
        ) : null}
      </Box>
    </Card>
  );
}
