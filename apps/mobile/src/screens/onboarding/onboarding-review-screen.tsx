/**
 * Onboarding review (spec §16): renders ONLY the server-built `BaseRulesCore` (+ the server's
 * draft for context) and signs it with a passkey; the hash of exactly this core is recomputed
 * locally before signing. Step 2 offers the rent mandate, signed separately over its mandateHash.
 */
import { effectiveSettings } from "@kassa/shared";
import { router } from "expo-router";
import { useState } from "react";

import { useConfirmOnboarding, useOnboardingReview } from "@/api/hooks/onboarding";
import { useCreateMandate } from "@/api/hooks/payees";
import { RowGroup } from "@/components/row-group";
import { errorText } from "@/components/kassa/error-text";
import { QueryView } from "@/components/kassa/query-view";
import { ScrollScreen } from "@/components/kassa/scroll-screen";
import { StatusChip } from "@/components/kassa/status-chip";
import { Box, Button, Card, Row, Text } from "@/components/ui";
import { useFormat } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { useKassaT } from "@/lib/i18n";
import { PasskeyCancelledError } from "@/lib/passkey-errors";
import { useChatStore } from "@/stores/chat";

export function OnboardingReviewScreen() {
  const t = useKassaT();
  const f = useFormat();
  const conversationId = useChatStore((s) => s.onboardingConversationId);
  const review = useOnboardingReview(conversationId);
  const confirmRules = useConfirmOnboarding(conversationId);
  const createMandate = useCreateMandate();
  const [step, setStep] = useState<"rules" | "mandate">("rules");
  const [error, setError] = useState<string | null>(null);

  const finish = () => router.replace("/home");

  return (
    <ScrollScreen>
      <QueryView query={review} skeletonRows={6}>
        {(r) => {
          const s = r.core.settings;
          const eff = effectiveSettings(s.preset, s.overrides);
          const caps = r.core.caps;
          const mandate = r.suggestedMandate;

          const signRules = async () => {
            setError(null);
            try {
              await confirmRules.mutateAsync(r);
              haptics.success();
              if (mandate) setStep("mandate");
              else finish();
            } catch (err) {
              if (err instanceof PasskeyCancelledError) return;
              haptics.error();
              setError(errorText(t, err));
            }
          };

          const signMandate = async () => {
            if (!mandate) return;
            setError(null);
            try {
              await createMandate.mutateAsync(mandate);
              haptics.success();
              finish();
            } catch (err) {
              if (err instanceof PasskeyCancelledError) return;
              haptics.error();
              setError(errorText(t, err));
            }
          };

          if (step === "mandate" && mandate) {
            return (
              <Box gap={5}>
                <StatusChip tone="positive" label={t("onboarding:rulesSigned")} />
                <Text variant="heading">{t("onboarding:mandateTitle")}</Text>
                <Text>{t("onboarding:mandateBody")}</Text>
                <RowGroup>
                  <Row
                    title={t("onboarding:mandatePayee")}
                    trailing={<Text>{r.suggestedMandatePayees.map((p) => p.name).join(", ")}</Text>}
                  />
                  <Row
                    title={t("onboarding:mandatePerPayment")}
                    trailing={<Text>{f.money(mandate.maxPerPaymentMinor, mandate.currency)}</Text>}
                  />
                  <Row
                    title={t("onboarding:mandatePerPeriod", {
                      period: t(`settings:mandates.period.${mandate.period}`),
                    })}
                    trailing={<Text>{f.money(mandate.maxPerPeriodMinor, mandate.currency)}</Text>}
                  />
                </RowGroup>
                <Text variant="caption">{t("onboarding:mandateDelay")}</Text>
                {error ? <Text color="destructive">{error}</Text> : null}
                <Button
                  size="lg"
                  onPress={() => void signMandate()}
                  loading={createMandate.isPending}
                >
                  {t("onboarding:signMandate")}
                </Button>
                <Button variant="ghost" onPress={finish}>
                  {t("onboarding:skipMandate")}
                </Button>
              </Box>
            );
          }

          return (
            <Box gap={5}>
              <Text>{t("onboarding:reviewIntro")}</Text>
              <RowGroup title={t("onboarding:rulesTitle")}>
                <Row
                  title={t("settings:presetTitle")}
                  trailing={<Text>{t(`settings:preset.${s.preset}.title`)}</Text>}
                />
                <Row
                  title={t("settings:moneyModeLabel")}
                  trailing={<Text>{t(`settings:moneyMode.${eff.moneyMode}`)}</Text>}
                />
                <Row
                  title={t("settings:paymentPolicyLabel")}
                  trailing={<Text>{t(`settings:paymentPolicy.${eff.paymentPolicy}`)}</Text>}
                />
                <Row
                  title={t("settings:regionLabel")}
                  trailing={<Text>{t(`settings:region.${s.region}`)}</Text>}
                />
                <Row
                  title={t("settings:homeCurrencyLabel")}
                  trailing={<Text>{s.homeCurrency}</Text>}
                />
                <Row
                  title={t("settings:notificationModeLabel")}
                  trailing={<Text>{t(`settings:notificationMode.${s.notificationMode}`)}</Text>}
                />
              </RowGroup>
              <RowGroup title={t("settings:capsTitle")}>
                <Row
                  title={t("settings:caps.perPaymentMinor")}
                  trailing={<Text>{f.money(caps.perPaymentMinor, caps.currency)}</Text>}
                />
                <Row
                  title={t("settings:caps.perDayMinor")}
                  trailing={<Text>{f.money(caps.perDayMinor, caps.currency)}</Text>}
                />
                <Row
                  title={t("settings:caps.perMonthMinor")}
                  trailing={<Text>{f.money(caps.perMonthMinor, caps.currency)}</Text>}
                />
                <Row
                  title={t("settings:caps.smallAutoMinor")}
                  trailing={<Text>{f.money(caps.smallAutoMinor, caps.currency)}</Text>}
                />
                <Row
                  title={t("settings:caps.reserveMinor")}
                  trailing={<Text>{f.money(caps.reserveMinor, caps.currency)}</Text>}
                />
              </RowGroup>
              {r.draft.budgets.length > 0 ? (
                <RowGroup title={t("home:budgets")}>
                  {r.draft.budgets.map((b) => (
                    <Row
                      key={b.category}
                      title={t(`common:category.${b.category}`, { defaultValue: b.category })}
                      trailing={<Text>{f.money(b.limitHomeMinor, s.homeCurrency)}</Text>}
                    />
                  ))}
                </RowGroup>
              ) : null}
              <Card>
                <Text variant="caption" selectable>
                  {t("onboarding:rulesHash", { hash: r.rulesHash.slice(0, 8) })}
                </Text>
              </Card>
              {error ? <Text color="destructive">{error}</Text> : null}
              <Button size="lg" onPress={() => void signRules()} loading={confirmRules.isPending}>
                {t("onboarding:signRules")}
              </Button>
              <Button variant="ghost" onPress={() => router.back()}>
                {t("onboarding:backToChat")}
              </Button>
            </Box>
          );
        }}
      </QueryView>
    </ScrollScreen>
  );
}
