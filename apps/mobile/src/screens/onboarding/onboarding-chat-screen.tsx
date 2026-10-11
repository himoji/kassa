import type { OnboardingProfileDraft } from "@kassa/shared";
import { router } from "expo-router";
import { useRef, useState } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";

import { useOnboardingMessage } from "@/api/hooks/onboarding";
import { errorText } from "@/components/kassa/error-text";
import { Box, Button, Card, Icon, Text, useTheme } from "@/components/ui";
import { useFormat } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { useKassaT } from "@/lib/i18n";
import { consentNeeded, type ConsentNeeded } from "@/screens/chat/consent";
import { ConsentCard } from "@/screens/chat/consent-card";
import { useChatStore } from "@/stores/chat";

interface Turn {
  id: number;
  role: "user" | "assistant";
  text: string;
}

function DraftSummary({ draft }: { draft: OnboardingProfileDraft }) {
  const t = useKassaT();
  const f = useFormat();
  return (
    <Card>
      <Box gap={2}>
        <Text weight="semibold">{t("onboarding:draftTitle")}</Text>
        {draft.homeCurrency ? (
          <Text variant="caption">
            {t("onboarding:draftHome", { currency: draft.homeCurrency })}
          </Text>
        ) : null}
        {draft.incomes.map((i, n) => (
          <Text key={`i${n}`} variant="caption">
            {t("onboarding:draftIncome", {
              source: i.source,
              amount: f.money(i.amountMinor, i.currency),
              cadence: t(`onboarding:cadence.${i.cadence}`),
            })}
          </Text>
        ))}
        {draft.obligations.map((o, n) => (
          <Text key={`o${n}`} variant="caption">
            {t("onboarding:draftBill", {
              payee: o.payeeName,
              amount: f.money(o.amountMinor, o.currency),
            })}
          </Text>
        ))}
        {draft.budgets.length > 0 ? (
          <Text variant="caption">
            {t("onboarding:draftBudgets", { count: draft.budgets.length })}
          </Text>
        ) : null}
      </Box>
    </Card>
  );
}

/** Onboarding by chat (spec §1, §8 POST /onboarding/message): the server builds the profile draft. */
export function OnboardingChatScreen() {
  const t = useKassaT();
  const { colors } = useTheme();
  const conversationId = useChatStore((s) => s.onboardingConversationId);
  const send = useOnboardingMessage();
  const [turns, setTurns] = useState<Turn[]>([
    { id: 0, role: "assistant", text: t("onboarding:greeting") },
  ]);
  const [input, setInput] = useState("");
  const [draft, setDraft] = useState<OnboardingProfileDraft | null>(null);
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 403 AI_CONSENT_REQUIRED / PIPL_CONSENT_REQUIRED: the onboarding chat is the AI's first use, and
  // Settings > Privacy is out of reach until onboarding ends, so the notice + "I agree" live here
  // (as in the agent chat), and the refused message is re-sent once consent is recorded.
  const [consent, setConsent] = useState<{ need: ConsentNeeded; text: string } | null>(null);
  const scroll = useRef<ScrollView>(null);

  const ask = async (text: string) => {
    setError(null);
    setConsent(null);
    try {
      const res = await send.mutateAsync({ conversationId, text });
      setTurns((prev) => [...prev, { id: prev.length, role: "assistant", text: res.reply }]);
      setDraft(res.draft);
      setComplete(res.complete);
      if (res.complete) haptics.success();
    } catch (err) {
      const need = consentNeeded(err);
      if (need) {
        setConsent({ need, text });
        return;
      }
      haptics.error();
      setError(errorText(t, err));
    }
  };

  const submit = async () => {
    const text = input.trim();
    if (!text || send.isPending) return;
    setInput("");
    setTurns((prev) => [...prev, { id: prev.length, role: "user", text }]);
    await ask(text);
  };

  return (
    <KeyboardAvoidingView
      behavior="padding"
      style={{ flex: 1, backgroundColor: colors.background }}
    >
      <ScrollView
        ref={scroll}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: 16, gap: 12 }}
        onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })}
      >
        {turns.map((turn) => (
          <View
            key={turn.id}
            style={{
              alignSelf: turn.role === "user" ? "flex-end" : "flex-start",
              maxWidth: "88%",
              paddingHorizontal: 14,
              paddingVertical: 10,
              borderRadius: 18,
              borderCurve: "continuous",
              backgroundColor: turn.role === "user" ? colors.brandAccent : colors.muted,
            }}
          >
            <Text selectable style={turn.role === "user" ? { color: "#ffffff" } : undefined}>
              {turn.text}
            </Text>
          </View>
        ))}
        {send.isPending ? <Text variant="caption">{t("chat:thinking")}</Text> : null}
        {error ? <Text color="destructive">{error}</Text> : null}
        {consent ? (
          <ConsentCard need={consent.need} onGiven={() => void ask(consent.text)} />
        ) : null}
        {draft ? <DraftSummary draft={draft} /> : null}
        {complete ? (
          <Button size="lg" onPress={() => router.push("/onboarding/review")}>
            {t("onboarding:toReview")}
          </Button>
        ) : null}
      </ScrollView>
      <View
        style={{
          flexDirection: "row",
          gap: 8,
          padding: 12,
          borderTopWidth: 1,
          borderTopColor: colors.border,
          alignItems: "flex-end",
        }}
      >
        <TextInput
          value={input}
          onChangeText={setInput}
          placeholder={t("onboarding:placeholder")}
          placeholderTextColor={colors.mutedForeground}
          accessibilityLabel={t("chat:inputA11y")}
          multiline
          style={{
            flex: 1,
            minHeight: 44,
            maxHeight: 140,
            paddingHorizontal: 14,
            paddingVertical: 10,
            borderRadius: 22,
            backgroundColor: colors.muted,
            color: colors.foreground,
            fontSize: 16,
          }}
        />
        <Pressable
          onPress={() => void submit()}
          accessibilityRole="button"
          accessibilityLabel={t("chat:send")}
          style={{
            width: 44,
            height: 44,
            borderRadius: 22,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: colors.brandAccent,
          }}
        >
          <Icon name="arrow.up" fallback="arrow_upward" size={20} color="primaryForeground" />
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}
