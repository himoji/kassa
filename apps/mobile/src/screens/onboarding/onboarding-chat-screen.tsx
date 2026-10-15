import type {
  ChoiceAnswer,
  DataChoices,
  ImportPreviewResponse,
  OnboardingProfileDraft,
} from "@kassa/shared";
import { router } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";
import { ChatLayout } from "@/components/kassa/chat-layout";
import Animated, { FadeIn } from "react-native-reanimated";

import { fetchOnboardingConversation } from "@/api/hooks/chat";
import {
  canPickFiles,
  pickImportFiles,
  useImportCommit,
  useImportFiles,
  useOnboardingHistory,
} from "@/api/hooks/dataport";
import { useMe } from "@/api/hooks/me";
import { useOnboardingMessage } from "@/api/hooks/onboarding";
import { ReplayBadge } from "@/components/kassa/badges";
import { ChoiceCard, withReplyAnswers } from "@/components/kassa/choice-card";
import { errorText } from "@/components/kassa/error-text";
import { Markdown } from "@/components/kassa/markdown";
import { Box, Button, Card, Icon, Loading, Text, useTheme } from "@/components/ui";
import { useFormat } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { useKassaT } from "@/lib/i18n";
import { consentNeeded, type ConsentNeeded } from "@/screens/chat/consent";
import { ConsentCard } from "@/screens/chat/consent-card";
import {
  ALL_ON,
  ImportPreviewCard,
  selectedItems,
  type SectionSwitches,
} from "@/screens/settings/import-preview";
import { useChatHydrated, useChatStore } from "@/stores/chat";

import { hasContent } from "./draft-content";

interface Turn {
  id: number;
  role: "user" | "assistant";
  text: string;
  ui: DataChoices[];
  /** Served from a recorded replay (REPLAY mode, or the live model was unavailable). */
  replay?: boolean;
}

/** Text of the first user turn after index `i`: a picker in turn `i` was answered by it. */
function laterUserText(turns: readonly Turn[], i: number): string | undefined {
  return turns.slice(i + 1).find((turn) => turn.role === "user")?.text;
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

/** The agent's "Upload statements" option (ONBOARDING_INSTRUCTIONS): the app opens the file picker for it. */
const UPLOAD_OPTION = "upload_statements";

/**
 * Onboarding by chat (spec §1, §8 POST /onboarding/message): the server builds the profile draft. Bank statements
 * (POST /import/file) prefill it: the spending is imported, and what the history taught Kassa joins the draft through
 * POST /onboarding/history, still to be reviewed and signed.
 */
export function OnboardingChatScreen() {
  const t = useKassaT();
  const { colors } = useTheme();
  const hydrated = useChatHydrated();
  const conversationId = useChatStore((s) => s.onboardingConversationId);
  const setConversationId = useChatStore((s) => s.setOnboardingConversationId);
  const send = useOnboardingMessage();
  const upload = useImportFiles();
  const commitImport = useImportCommit();
  const historyTurn = useOnboardingHistory();
  const [statements, setStatements] = useState<ImportPreviewResponse | null>(null);
  const [statementSections, setStatementSections] = useState<SectionSwitches>(ALL_ON);
  const me = useMe();
  // Ask for AI consent before the first message, not after it is refused (the PIPL step, which depends on the region
  // the chat learns, still arrives as a refusal below).
  const consentFirst: ConsentNeeded | null =
    me.data && me.data.aiConsentAt === null
      ? {
          code: "AI_CONSENT_REQUIRED",
          noticeText: me.data.aiNotice?.text ?? null,
          endpoint: "/privacy/ai-consent",
        }
      : null;
  const [loaded, setLoaded] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([
    { id: 0, role: "assistant", text: t("onboarding:greeting"), ui: [] },
  ]);
  const [input, setInput] = useState("");
  const [draft, setDraft] = useState<OnboardingProfileDraft | null>(null);
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 403 AI_CONSENT_REQUIRED / PIPL_CONSENT_REQUIRED: the onboarding chat is the AI's first use, and
  // Settings > Privacy is out of reach until onboarding ends, so the notice + "I agree" live here
  // (as in the agent chat), and the refused message is re-sent once consent is recorded.
  const [consent, setConsent] = useState<{
    need: ConsentNeeded;
    text: string;
    choice?: ChoiceAnswer;
  } | null>(null);
  const scroll = useRef<ScrollView>(null);

  // Resume the server-side conversation after a reload: its id (kept in the store, which the
  // review screen reads too), the turns so far and the draft.
  useEffect(() => {
    if (!hydrated) return;
    const ctrl = new AbortController();
    fetchOnboardingConversation(ctrl.signal)
      .then((res) => {
        if (res.conversationId) setConversationId(res.conversationId);
        if (res.turns.length > 0) {
          setTurns(res.turns.map((turn, id) => ({ id, ...turn })));
        }
        setDraft(res.draft);
        setComplete(res.complete);
      })
      .catch(() => {})
      .finally(() => {
        if (!ctrl.signal.aborted) setLoaded(true);
      });
    return () => ctrl.abort();
  }, [hydrated, setConversationId]);

  const ask = async (text: string, choice?: ChoiceAnswer) => {
    setError(null);
    setConsent(null);
    try {
      const res = await send.mutateAsync({ conversationId, text, ...(choice ? { choice } : {}) });
      setTurns((prev) => [
        ...prev,
        { id: prev.length, role: "assistant", text: res.reply, ui: res.ui, replay: res.replay },
      ]);
      setDraft(res.draft);
      setComplete(res.complete);
      if (res.complete) haptics.success();
    } catch (err) {
      const need = consentNeeded(err);
      if (need) {
        setConsent({ need, text, choice });
        return;
      }
      haptics.error();
      setError(errorText(t, err));
    }
  };

  const submit = async (text = input.trim(), choice?: ChoiceAnswer) => {
    if (!text || send.isPending) return;
    if (!choice) setInput("");
    setTurns((prev) => [...prev, { id: prev.length, role: "user", text, ui: [] }]);
    await ask(text, choice);
  };

  /** Pick statements and read them (nothing is written until "Use this history"). False when nothing was read. */
  const uploadStatements = async (): Promise<boolean> => {
    setError(null);
    if (!canPickFiles()) {
      setError(t("settings:data.chooseFileUnavailable"));
      return false;
    }
    const files = await pickImportFiles();
    if (!files) return false;
    try {
      const res = await upload.mutateAsync({ files });
      setStatements(res);
      setStatementSections(ALL_ON);
      return true;
    } catch (err) {
      haptics.error();
      setError(errorText(t, err));
      return false;
    }
  };

  /** Import the spending and cards now; incomes, bills and budgets go into the draft for review. */
  const applyStatements = async () => {
    if (!statements?.history) return;
    setError(null);
    const items = selectedItems(statements, statementSections);
    try {
      await commitImport.mutateAsync({
        transactions: items.transactions,
        cards: items.cards,
        bills: [],
        budgets: [],
        incomes: [],
      });
      const res = await historyTurn.mutateAsync({
        conversationId,
        history: statements.history,
        files: statements.files,
        items: {
          incomes: items.incomes,
          bills: items.bills,
          budgets: items.budgets,
          cards: items.cards,
        },
      });
      setTurns((prev) => [
        ...prev,
        {
          id: prev.length,
          role: "user",
          text: t("onboarding:statementsShared", { count: statements.files.length }),
          ui: [],
        },
        { id: prev.length + 1, role: "assistant", text: res.reply, ui: res.ui },
      ]);
      setDraft(res.draft);
      setComplete(res.complete);
      setStatements(null);
      haptics.success();
    } catch (err) {
      haptics.error();
      setError(errorText(t, err));
    }
  };

  if (!hydrated || !loaded) return <Loading label={t("chat:loadingHistory")} />;

  return (
    <ChatLayout
      composer={
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
          <Pressable
            onPress={() => void uploadStatements()}
            disabled={Boolean(consentFirst) || upload.isPending}
            accessibilityRole="button"
            accessibilityLabel={t("onboarding:uploadStatements")}
            style={{
              width: 44,
              height: 44,
              borderRadius: 22,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: colors.muted,
            }}
          >
            <Icon name="paperclip" fallback="attach_file" size={20} color="foreground" />
          </Pressable>
          <TextInput
            editable={!consentFirst}
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
            onPress={() => void submit(input.trim())}
            disabled={Boolean(consentFirst)}
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
      }
    >
      <ScrollView
        ref={scroll}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        contentContainerStyle={{ padding: 16, gap: 12 }}
        onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })}
      >
        {turns.map((turn, index) => (
          <View key={turn.id} style={{ gap: 8 }}>
            <View
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
              {turn.role === "user" ? (
                <Text selectable style={{ color: "#ffffff" }}>
                  {turn.text}
                </Text>
              ) : (
                <Markdown>{turn.text}</Markdown>
              )}
            </View>
            {turn.replay ? <ReplayBadge force /> : null}
            {withReplyAnswers(turn.ui, laterUserText(turns, index)).map((part) => (
              <ChoiceCard
                key={part.id}
                part={part}
                disabled={send.isPending}
                onAnswer={(a) => {
                  const picked = a.choice?.optionId ?? a.choice?.optionIds?.[0];
                  // "Upload statements" opens the file picker instead of answering; cancelling unlocks the card.
                  if (picked === UPLOAD_OPTION) return uploadStatements();
                  void submit(a.text, a.choice);
                }}
              />
            ))}
          </View>
        ))}
        {send.isPending ? <Text variant="caption">{t("chat:thinking")}</Text> : null}
        {upload.isPending ? <Text variant="caption">{t("settings:data.reading")}</Text> : null}
        {statements ? (
          <ImportPreviewCard
            result={statements}
            on={statementSections}
            setOn={setStatementSections}
            onImport={() => void applyStatements()}
            busy={commitImport.isPending || historyTurn.isPending}
            importLabel={t("onboarding:useStatements")}
          />
        ) : null}
        {error ? <Text color="destructive">{error}</Text> : null}
        {consentFirst && !consent ? (
          <ConsentCard need={consentFirst} onGiven={() => void me.refetch()} />
        ) : null}
        {consent ? (
          <ConsentCard
            need={consent.need}
            onGiven={() => {
              void me.refetch();
              void ask(consent.text, consent.choice);
            }}
          />
        ) : null}
        {draft && hasContent(draft) ? (
          <Animated.View entering={FadeIn}>
            <DraftSummary draft={draft} />
          </Animated.View>
        ) : null}
        {complete ? (
          <Button size="lg" onPress={() => router.push("/onboarding/review")}>
            {t("onboarding:toReview")}
          </Button>
        ) : null}
      </ScrollView>
    </ChatLayout>
  );
}
