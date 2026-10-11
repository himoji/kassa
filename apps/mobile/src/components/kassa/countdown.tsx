import { Text } from "@/components/ui";
import { useDemoNow } from "@/hooks/use-demo-now";
import { useKassaT, type TFn } from "@/lib/i18n";

/** "23 h 05 min" style remaining time, localised through i18n (no Intl.DurationFormat on Hermes). */
export function formatRemaining(t: TFn, ms: number): string {
  if (ms <= 0) return t("common:countdown.due");
  const totalMinutes = Math.ceil(ms / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return t("common:countdown.dh", { days, hours });
  if (hours > 0) return t("common:countdown.hm", { hours, minutes });
  return t("common:countdown.m", { minutes });
}

/** Live countdown on the demo clock (spec §15), so +1 h / +1 day in the demo panel moves it. */
export function Countdown({ until, prefixKey }: { until: string; prefixKey?: string }) {
  const t = useKassaT();
  const now = useDemoNow();
  const remaining = formatRemaining(t, Date.parse(until) - now);
  return (
    <Text variant="caption" style={{ fontVariant: ["tabular-nums"] }}>
      {prefixKey ? t(prefixKey, { remaining }) : remaining}
    </Text>
  );
}

/** The remaining-time string itself, for chips. */
export function useRemaining(until: string | null): string | null {
  const t = useKassaT();
  const now = useDemoNow();
  return until ? formatRemaining(t, Date.parse(until) - now) : null;
}
