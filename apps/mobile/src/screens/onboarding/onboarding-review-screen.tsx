/**
 * Onboarding review (spec §16): renders ONLY the server-built `BaseRulesCore` (+ the server's
 * draft for context) and signs it with a passkey; the hash of exactly this core is recomputed
 * locally before signing. Step 2 offers the rent mandate, signed separately over its mandateHash. The
 * mandate comes from the confirm response: a new user's rent bill only exists once the signed draft is
 * applied, so the review (built before) usually has none. Rules → mandate (sign or skip) → home.
 * Presented as a form sheet over the onboarding chat (onboarding/_layout.tsx), like the order sheet.
 * The caps and budgets are editable with sliders: edits go back to the server (debounced), which rebuilds
 * the core, so the signed rules are still exactly the server's.
 */
import {
  effectiveSettings,
  type CapsPatch,
  type OnboardingConfirmOptionsResponse,
} from "@kassa/shared";
import { router } from "expo-router";
import { useEffect, useState, type ReactNode } from "react";
import { ScrollView, View } from "react-native";

import { fetchOnboardingConversation } from "@/api/hooks/chat";
import {
  type OnboardingReviewEdits,
  useConfirmOnboarding,
  useOnboardingReview,
} from "@/api/hooks/onboarding";
import { useCreateMandate } from "@/api/hooks/payees";
import { AmountsEditor } from "@/components/kassa/amounts-editor";
import { errorText } from "@/components/kassa/error-text";
import { PasskeyButton } from "@/components/kassa/passkey-button";
import { QueryView } from "@/components/kassa/query-view";
import { StatusChip } from "@/components/kassa/status-chip";
import { Box, Button, Divider, Loading, Text, useTheme } from "@/components/ui";
import { amountRange } from "@/lib/amount-slider";
import { categoryEmoji } from "@/lib/category-emoji";
import { useFormat } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { useKassaT } from "@/lib/i18n";
import { PasskeyCancelledError } from "@/lib/passkey-errors";
import { useChatHydrated, useChatStore } from "@/stores/chat";

import { mandateOfferAfterRules, type MandateOffer } from "./mandate-offer";

/**
 * The conversation id survives a reload (persisted store) and is re-read from the server
 * (GET /onboarding/conversation) before the review is requested.
 */
export function OnboardingReviewScreen() {
  const t = useKassaT();
  const hydrated = useChatHydrated();
  const setConversationId = useChatStore((s) => s.setOnboardingConversationId);
  const [synced, setSynced] = useState(false);
  useEffect(() => {
    if (!hydrated) return;
    const ctrl = new AbortController();
    fetchOnboardingConversation(ctrl.signal)
      .then((res) => {
        if (res.conversationId) setConversationId(res.conversationId);
      })
      .catch(() => {})
      .finally(() => {
        if (!ctrl.signal.aborted) setSynced(true);
      });
    return () => ctrl.abort();
  }, [hydrated, setConversationId]);
  if (!hydrated || !synced) return <Loading label={t("chat:loadingHistory")} />;
  return (
    <SheetScroll>
      <OnboardingReview />
    </SheetScroll>
  );
}

/** One label / value line, as on the order sheet. */
function Field({ label, value }: { label: string; value: string }) {
  return (
    <Box row justify="between" gap={4} style={{ minHeight: 28, alignItems: "flex-start" }}>
      <Text variant="caption">{label}</Text>
      <Text style={{ flexShrink: 1, textAlign: "right" }}>{value}</Text>
    </Box>
  );
}

/** Sheet body: content on top, the actions pinned to the bottom of the sheet. */
function SheetBody({
  testID,
  children,
  actions,
}: {
  testID?: string;
  children: ReactNode;
  actions: ReactNode;
}) {
  return (
    <View style={{ flex: 1, padding: 20, gap: 20 }} testID={testID}>
      {children}
      <View style={{ flex: 1 }} />
      <Box gap={3}>{actions}</Box>
    </View>
  );
}

type CapKey = keyof CapsPatch;
/** `positive`: the server refuses 0 (the limits); the auto-pay limit and the reserve may be 0. */
const CAP_ROWS: { key: CapKey; emoji: string; positive?: true }[] = [
  { key: "perPaymentMinor", emoji: "💳", positive: true },
  { key: "perDayMinor", emoji: "📅", positive: true },
  { key: "perMonthMinor", emoji: "🗓️", positive: true },
  { key: "smallAutoMinor", emoji: "⚡" },
  { key: "reserveMinor", emoji: "🛟" },
];

/** Slider range around the first review's value; positive amounts start at one step. */
function reviewRange(initialMinor: number, positive?: boolean) {
  const r = amountRange(initialMinor);
  return positive ? amountRange(initialMinor, { minMinor: r.step }) : r;
}

/** Local slider values, sent to the server this long after the last change. */
const EDIT_DEBOUNCE_MS = 350;

function useDebounced<T>(value: T, ms: number): T {
  const [out, setOut] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setOut(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return out;
}

function OnboardingReview() {
  const t = useKassaT();
  const f = useFormat();
  const conversationId = useChatStore((s) => s.onboardingConversationId);
  const [edits, setEdits] = useState<OnboardingReviewEdits>({});
  const sentEdits = useDebounced(edits, EDIT_DEBOUNCE_MS);
  const review = useOnboardingReview(conversationId, sentEdits);
  // Slider ranges come from the first (unedited) review, so they do not move while the user drags.
  const [baseline, setBaseline] = useState<OnboardingConfirmOptionsResponse | null>(null);
  if (review.data && !baseline) setBaseline(review.data);
  const syncing = edits !== sentEdits || !!review.isFetching;
  const confirmRules = useConfirmOnboarding(conversationId);
  const createMandate = useCreateMandate();
  // Set once the rules are signed and the server offers a mandate: step 2. Rendered without the review
  // query, so a refetch of the (now signed) review cannot take the user back to step 1.
  const [offer, setOffer] = useState<MandateOffer | null>(null);
  const [error, setError] = useState<string | null>(null);

  const finish = () => router.replace("/home");

  const signMandate = async (mandate: MandateOffer["mandate"]) => {
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

  const errorLine = error ? <Text color="destructive">{error}</Text> : null;

  if (offer) {
    const { mandate, payees } = offer;
    return (
      <SheetBody
        testID="onboarding-mandate-step"
        actions={
          <>
            <PasskeyButton
              onPress={() => void signMandate(mandate)}
              loading={createMandate.isPending}
            >
              {t("onboarding:signMandate")}
            </PasskeyButton>
            <Button size="lg" variant="ghost" onPress={finish}>
              {t("onboarding:skipMandate")}
            </Button>
          </>
        }
      >
        <Box gap={2}>
          <StatusChip tone="positive" label={t("onboarding:rulesSigned")} />
          <Text variant="title">{t("onboarding:mandateTitle")}</Text>
          <Text variant="caption">{t("onboarding:mandateBody")}</Text>
        </Box>
        <Box gap={2}>
          <Field
            label={t("onboarding:mandatePayee")}
            value={payees.map((p) => p.name).join(", ")}
          />
          <Field
            label={t("onboarding:mandatePerPayment")}
            value={f.money(mandate.maxPerPaymentMinor, mandate.currency)}
          />
          <Field
            label={t("onboarding:mandatePerPeriod", {
              period: t(`settings:mandates.period.${mandate.period}`),
            })}
            value={f.money(mandate.maxPerPeriodMinor, mandate.currency)}
          />
        </Box>
        <Text variant="caption">{t("onboarding:mandateDelay")}</Text>
        {errorLine}
      </SheetBody>
    );
  }

  return (
    <QueryView query={review} skeletonRows={6}>
      {(r) => {
        const s = r.core.settings;
        const eff = effectiveSettings(s.preset, s.overrides);
        const caps = r.core.caps;
        const base = baseline ?? r;

        const signRules = async () => {
          setError(null);
          try {
            const confirmed = await confirmRules.mutateAsync(r);
            haptics.success();
            const next = mandateOfferAfterRules(confirmed, r);
            if (next) setOffer(next);
            else finish();
          } catch (err) {
            if (err instanceof PasskeyCancelledError) return;
            haptics.error();
            setError(errorText(t, err));
          }
        };

        return (
          <SheetBody
            testID="onboarding-review-step"
            actions={
              <>
                <PasskeyButton
                  onPress={() => void signRules()}
                  loading={confirmRules.isPending}
                  disabled={syncing}
                >
                  {t("onboarding:signRules")}
                </PasskeyButton>
                <Button size="lg" variant="ghost" onPress={() => router.back()}>
                  {t("onboarding:backToChat")}
                </Button>
              </>
            }
          >
            <Box gap={1}>
              <Text variant="caption">{t("onboarding:rulesTitle")}</Text>
              <Text variant="title">{t(`settings:preset.${s.preset}.title`)}</Text>
              <Text variant="caption">{t("onboarding:reviewIntro")}</Text>
            </Box>

            <Box gap={2}>
              <Field
                label={t("settings:moneyModeLabel")}
                value={t(`settings:moneyMode.${eff.moneyMode}`)}
              />
              <Field
                label={t("settings:paymentPolicyLabel")}
                value={t(`settings:paymentPolicy.${eff.paymentPolicy}`)}
              />
              <Field
                label={t("settings:regionLabel")}
                value={`${t(`settings:region.${s.region}`)} · ${s.homeCurrency}`}
              />
              <Field
                label={t("settings:notificationModeLabel")}
                value={t(`settings:notificationMode.${s.notificationMode}`)}
              />
            </Box>

            <Divider spacing={0} />

            <Box gap={3}>
              <Text variant="label">{t("settings:capsTitle")}</Text>
              <AmountsEditor
                currency={caps.currency}
                disabled={confirmRules.isPending}
                items={CAP_ROWS.map(({ key, emoji, positive }) => ({
                  id: key,
                  label: t(`settings:caps.${key}`),
                  emoji,
                  valueMinor: edits.caps?.[key] ?? caps[key],
                  range: reviewRange(base.core.caps[key], positive),
                }))}
                onChange={(id, v) =>
                  setEdits((e) => ({ ...e, caps: { ...e.caps, [id as CapKey]: v } }))
                }
              />
            </Box>

            {r.draft.budgets.length > 0 ? (
              <>
                <Divider spacing={0} />
                <Box gap={3}>
                  <Text variant="label">{t("home:budgets")}</Text>
                  <AmountsEditor
                    currency={s.homeCurrency}
                    disabled={confirmRules.isPending}
                    totalLabel={t("chat:choice.total")}
                    items={r.draft.budgets.map((b) => {
                      const edited = edits.budgets?.find((x) => x.category === b.category);
                      const initial =
                        base.draft.budgets.find((x) => x.category === b.category)?.limitHomeMinor ??
                        b.limitHomeMinor;
                      return {
                        id: b.category,
                        label: t(`common:category.${b.category}`, { defaultValue: b.category }),
                        emoji: categoryEmoji(b.category),
                        valueMinor: edited?.limitHomeMinor ?? b.limitHomeMinor,
                        range: reviewRange(initial, true),
                      };
                    })}
                    onChange={(category, v) =>
                      setEdits((e) => ({
                        ...e,
                        budgets: [
                          ...(e.budgets ?? []).filter((x) => x.category !== category),
                          { category, limitHomeMinor: v },
                        ],
                      }))
                    }
                  />
                </Box>
              </>
            ) : null}

            <Text variant="caption" selectable>
              {t("onboarding:rulesHash", { hash: r.rulesHash.slice(0, 8) })}
            </Text>
            {errorLine}
          </SheetBody>
        );
      }}
    </QueryView>
  );
}

/** The sheet's scroll container: content grows to fill the sheet so the actions sit at its bottom. */
function SheetScroll({ children }: { children: ReactNode }) {
  const { colors } = useTheme();
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.background }}
      contentContainerStyle={{ flexGrow: 1 }}
      contentInsetAdjustmentBehavior="automatic"
    >
      {children}
    </ScrollView>
  );
}
