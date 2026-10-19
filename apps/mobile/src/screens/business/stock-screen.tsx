import { useBusinessInventory } from "@/api/hooks/business";
import { QueryView } from "@/components/kassa/query-view";
import { ScrollScreen } from "@/components/kassa/scroll-screen";
import { StatusChip } from "@/components/kassa/status-chip";
import { RowGroup } from "@/components/row-group";
import { Row, Text } from "@/components/ui";
import { useFormat } from "@/lib/format";
import { useKassaT } from "@/lib/i18n";

import { qtyText } from "./business-text";

/** Kassa Business "Stock": on-hand per item, the forecast need to the end of tomorrow, and the shortage. */
export function StockScreen() {
  const t = useKassaT();
  const f = useFormat();
  const inventory = useBusinessInventory();
  const q = (n: number, unit: string) => qtyText(n, unit, t, f.locale);

  return (
    <ScrollScreen onRefresh={() => inventory.refetch()}>
      <QueryView
        query={inventory}
        isEmpty={(i) => i.items.length === 0}
        empty={<Text variant="caption">{t("business:stockEmpty")}</Text>}
      >
        {(inv) => (
          <RowGroup title={inv.merchant.name} footer={t("business:stockFooter")}>
            {inv.items.map((item) => (
              <Row
                key={item.sku}
                testID={`stock-${item.sku}`}
                title={item.name}
                subtitle={
                  item.incoming > 0
                    ? t("business:stockIncoming", {
                        onHand: q(item.onHand, item.unit),
                        need: q(item.need + item.safety, item.unit),
                        incoming: q(item.incoming, item.unit),
                      })
                    : t("business:stockOnHand", {
                        onHand: q(item.onHand, item.unit),
                        need: q(item.need + item.safety, item.unit),
                      })
                }
                trailing={
                  item.shortage > 0 ? (
                    <StatusChip
                      tone="critical"
                      label={t("business:stockShort", { qty: q(item.shortage, item.unit) })}
                    />
                  ) : (
                    <StatusChip tone="positive" label={t("business:stockOk")} />
                  )
                }
              />
            ))}
          </RowGroup>
        )}
      </QueryView>
    </ScrollScreen>
  );
}
