/**
 * (added 2026-10-14, Business M2/M3) A shop order's status as the shop reports it: the steps of its channel's flow,
 * done / current / next, with the time of each reported step. Used on the order sheet and in Activity → Orders.
 */
import { SHOP_DELIVERY_FLOW, SHOP_TILL_FLOW, type ShopOrderView } from "@kassa/shared";
import { View } from "react-native";

import { SimulatedBadge } from "@/components/kassa/badges";
import { StatusChip } from "@/components/kassa/status-chip";
import { Box, Card, Icon, Text } from "@/components/ui";
import { useFormat } from "@/lib/format";
import { useKassaT } from "@/lib/i18n";

/** The steps shown for an order: its flow (without the optional AWAITING_PAYMENT unless it happened), or the end state. */
export function timelineSteps(
  o: Pick<ShopOrderView, "channel" | "status" | "timeline">
): { status: string; at: string | null; state: "done" | "current" | "next" | "failed" }[] {
  const flow: readonly string[] = o.channel === "TILL" ? SHOP_TILL_FLOW : SHOP_DELIVERY_FLOW;
  const seen = new Map(o.timeline.map((e) => [e.status, e.at]));
  const failed = o.status === "DECLINED" || o.status === "FAILED";
  const steps = flow.filter((s) => s !== "AWAITING_PAYMENT" || seen.has(s));
  if (failed) {
    return [
      ...steps
        .filter((s) => seen.has(s))
        .map((s) => ({ status: s, at: seen.get(s) ?? null, state: "done" as const })),
      { status: o.status, at: seen.get(o.status) ?? null, state: "failed" as const },
    ];
  }
  const current = steps.indexOf(o.status);
  return steps.map((s, i) => ({
    status: s,
    at: seen.get(s) ?? null,
    state:
      i < current ? ("done" as const) : i === current ? ("current" as const) : ("next" as const),
  }));
}

export function ShopOrderTimeline({ order, testID }: { order: ShopOrderView; testID?: string }) {
  const t = useKassaT();
  const f = useFormat();
  const steps = timelineSteps(order);
  const failed = order.status === "DECLINED" || order.status === "FAILED";
  return (
    <View testID={testID}>
      <Card>
        <Box gap={3}>
          <Box row justify="between" align="center" gap={2}>
            <Text weight="semibold" style={{ flexShrink: 1 }}>
              {order.merchantName}
            </Text>
            <StatusChip
              tone={failed ? "critical" : order.final ? "positive" : "info"}
              label={t(`shop:status.${order.status}`, { defaultValue: order.status })}
            />
          </Box>
          <Text variant="caption">
            {t(`shop:channel.${order.channel}`)} · {f.money(order.totalMinor, order.currency)}
          </Text>
          <Box gap={1}>
            {order.items.map((i) => (
              <Text key={i.sku} variant="caption">
                {t("shop:item", { qty: i.qty, name: i.name ?? i.sku })}
              </Text>
            ))}
          </Box>
          <View accessibilityRole="list" style={{ gap: 8 }}>
            {steps.map((s) => (
              <Box key={s.status} row gap={2} align="center">
                <Icon
                  name={
                    s.state === "failed"
                      ? "xmark.circle.fill"
                      : s.state === "next"
                        ? "circle"
                        : "checkmark.circle.fill"
                  }
                  fallback={
                    s.state === "failed"
                      ? "cancel"
                      : s.state === "next"
                        ? "radio_button_unchecked"
                        : "check_circle"
                  }
                  size={18}
                  color={
                    s.state === "failed"
                      ? "destructive"
                      : s.state === "next"
                        ? "mutedForeground"
                        : "primary"
                  }
                />
                <Text
                  weight={s.state === "current" ? "semibold" : undefined}
                  style={{ flexShrink: 1 }}
                >
                  {t(`shop:status.${s.status}`, { defaultValue: s.status })}
                </Text>
                {s.at ? <Text variant="caption">{f.dateTime(s.at)}</Text> : null}
              </Box>
            ))}
          </View>
          {order.reasonCode ? (
            <Text variant="caption">{t("shop:reason", { code: order.reasonCode })}</Text>
          ) : null}
          <Text variant="caption">
            {order.channel === "TILL" ? t("shop:tillHint") : t("shop:timelineHint")}
          </Text>
          <SimulatedBadge />
        </Box>
      </Card>
    </View>
  );
}
