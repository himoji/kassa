import type { CapsDto, CapsPatch } from "@kassa/shared";
import { useState } from "react";

import { useCaps } from "@/api/hooks/settings";
import { RowGroup } from "@/components/row-group";
import { SettingSlider } from "@/components/kassa/native-controls";
import { QueryView } from "@/components/kassa/query-view";
import { Box, Button, Row, Text } from "@/components/ui";
import { useFormat } from "@/lib/format";
import { useKassaT } from "@/lib/i18n";

import { useApplySettings } from "./use-settings-update";

type CapKey = keyof CapsPatch;
const CAP_KEYS: CapKey[] = [
  "perPaymentMinor",
  "perDayMinor",
  "perMonthMinor",
  "smallAutoMinor",
  "reserveMinor",
];

/**
 * Slider quantisation for an amount in minor units: a power of ten about a tenth of the current
 * value, so the slider has 10-30 stops. Input granularity only - the server validates the cap.
 */
export function sliderStep(currentMinor: number): number {
  const base = Math.max(1, Math.abs(currentMinor) / 10);
  return 10 ** Math.floor(Math.log10(base));
}

function sliderMax(currentMinor: number, step: number): number {
  return Math.max(step * 30, Math.ceil((currentMinor * 3) / step) * step);
}

/** Lowering applies instantly; raising needs a passkey and waits 24 h (I8). */
export function CapsSection() {
  const t = useKassaT();
  const f = useFormat();
  const caps = useCaps();
  const { apply, pending } = useApplySettings();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<CapsDto | null>(null);

  return (
    <QueryView query={caps} skeletonRows={2}>
      {({ caps: current }) => {
        const value = editing && draft ? draft : current;
        const changed = CAP_KEYS.filter((k) => value[k] !== current[k]);
        return (
          <RowGroup title={t("settings:capsTitle")} footer={t("settings:capsFooter")}>
            {CAP_KEYS.map((k) =>
              editing ? (
                <SettingSlider
                  key={k}
                  label={t(`settings:caps.${k}`)}
                  valueLabel={f.money(value[k], current.currency)}
                  value={value[k]}
                  min={0}
                  max={sliderMax(current[k], sliderStep(current[k]))}
                  step={sliderStep(current[k])}
                  onChange={(v) => setDraft({ ...value, [k]: Math.round(v) })}
                />
              ) : (
                <Row
                  key={k}
                  title={t(`settings:caps.${k}`)}
                  trailing={
                    <Text weight="semibold" style={{ fontVariant: ["tabular-nums"] }}>
                      {f.money(current[k], current.currency)}
                    </Text>
                  }
                />
              )
            )}
            <Box p={3} row gap={2}>
              {editing ? (
                <>
                  <Box flex={1}>
                    <Button
                      variant="outline"
                      onPress={() => {
                        setEditing(false);
                        setDraft(current);
                      }}
                    >
                      {t("common:cancel")}
                    </Button>
                  </Box>
                  <Box flex={1}>
                    <Button
                      loading={pending}
                      disabled={changed.length === 0}
                      onPress={async () => {
                        const patch: CapsPatch = Object.fromEntries(
                          changed.map((k) => [k, value[k]])
                        );
                        const ok = await apply({ caps: patch });
                        if (ok) setEditing(false);
                      }}
                    >
                      {t("settings:saveCaps")}
                    </Button>
                  </Box>
                </>
              ) : (
                <Box flex={1}>
                  <Button
                    variant="outline"
                    onPress={() => {
                      setDraft(current);
                      setEditing(true);
                    }}
                  >
                    {t("settings:editCaps")}
                  </Button>
                </Box>
              )}
            </Box>
          </RowGroup>
        );
      }}
    </QueryView>
  );
}
