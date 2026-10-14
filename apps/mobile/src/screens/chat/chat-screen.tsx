import { useChat } from "@ai-sdk/react";
import { router, Stack, type Href } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";

import { agentChatSchemas, createAgentTransport, type KassaUIMessage } from "@/api/agent-transport";
import { fetchConversationMessages, useConversations } from "@/api/hooks/chat";
import { keys } from "@/api/keys";
import { useSetBudgets } from "@/api/hooks/money";
import { ReplayBadge } from "@/components/kassa/badges";
import { BudgetImpactView } from "@/components/kassa/budget-impact";
import { ChatLayout } from "@/components/kassa/chat-layout";
import {
  ChoiceCard,
  withReplyAnswer,
  type ChoiceAnswerInput,
  type ChoiceCardProps,
} from "@/components/kassa/choice-card";
import { errorText } from "@/components/kassa/error-text";
import { Markdown } from "@/components/kassa/markdown";
import { ProposalCard } from "@/components/kassa/proposal-card";
import { RouteComparison } from "@/components/kassa/route-comparison";
import { Box, Button, Card, Icon, Loading, Text, toast, useTheme } from "@/components/ui";
import { readCachedMessages, writeCachedMessages } from "@/lib/chat-cache";
import { haptics } from "@/lib/haptics";
import { useKassaT } from "@/lib/i18n";
import { PasskeyCancelledError } from "@/lib/passkey-errors";
import { useChatHydrated, useChatStore } from "@/stores/chat";

import { isLiteBuild } from "@/lite/variant";
import { HeaderButtons } from "@/navigation/header-buttons";

import { consentNeeded } from "./consent";
import { ConsentCard } from "./consent-card";

const SUGGESTIONS = ["chat:suggest.tuition", "chat:suggest.budget", "chat:suggest.log"] as const;
/** KassaLite cannot approve payments (no passkey): questions about spending instead. */
const LITE_SUGGESTIONS = [
  "chat:suggest.week",
  "chat:suggest.where",
  "chat:suggest.budget",
] as const;

/** Collapsed stand-in for a data card while the reply is still streaming. */
function PendingRow({ label }: { label: string }) {
  const { colors } = useTheme();
  return (
    <View
      style={{
        alignSelf: "flex-start",
        paddingHorizontal: 14,
        paddingVertical: 10,
        borderRadius: 18,
        borderCurve: "continuous",
        backgroundColor: colors.muted,
      }}
    >
      <Text variant="caption">{label}</Text>
    </View>
  );
}

/** Text of the first user message after index `i`, if any. */
function laterUserText(messages: readonly KassaUIMessage[], i: number): string | undefined {
  const later = messages.slice(i + 1).find((m) => m.role === "user");
  return later ? messageText(later) : undefined;
}

function messageText(m: KassaUIMessage): string {
  return m.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
}

/**
 * Text parts render first, then the data cards they explain. `pending` (last message, still
 * streaming) keeps the cards collapsed until the reply is complete.
 */
function MessageParts({
  message,
  pending,
  answerText,
  busy,
  onChoice,
}: {
  message: KassaUIMessage;
  pending?: boolean;
  /** Text of the user message that followed this one: a picker in this message was answered. */
  answerText?: string;
  busy?: boolean;
  onChoice: ChoiceCardProps["onAnswer"];
}) {
  const t = useKassaT();
  const { colors } = useTheme();
  const mine = message.role === "user";
  const indexed = message.parts.map((part, i) => ({ part, i }));
  const ordered = [
    ...indexed.filter(({ part }) => part.type === "text"),
    ...indexed.filter(({ part }) => part.type !== "text"),
  ];
  return (
    <View style={{ gap: 8, alignItems: mine ? "flex-end" : "stretch" }}>
      {message.metadata?.replay ? <ReplayBadge force /> : null}
      {ordered.map(({ part, i }) => {
        const key = `${message.id}-${i}`;
        switch (part.type) {
          case "text":
            if (part.text.length === 0) return null;
            return (
              <View
                key={key}
                style={{
                  maxWidth: "88%",
                  paddingHorizontal: 14,
                  paddingVertical: 10,
                  borderRadius: 18,
                  borderCurve: "continuous",
                  backgroundColor: mine ? colors.brandAccent : colors.muted,
                }}
              >
                {mine ? (
                  <Text selectable style={{ color: "#ffffff" }}>
                    {part.text}
                  </Text>
                ) : (
                  <Markdown>{part.text}</Markdown>
                )}
              </View>
            );
          case "data-proposal":
            if (pending) return <PendingRow key={key} label={t("chat:preparing.proposal")} />;
            return <ProposalCard key={key} proposal={part.data} />;
          case "data-routes":
            if (pending) return <PendingRow key={key} label={t("chat:preparing.routes")} />;
            return (
              <RouteComparison
                key={key}
                routes={part.data.routes}
                homeCurrency={part.data.homeCurrency}
                amountMinor={part.data.amountMinor}
                toCurrency={part.data.toCurrency}
              />
            );
          case "data-budget-impact":
            if (pending) return <PendingRow key={key} label={t("chat:preparing.budgetImpact")} />;
            return (
              <Card key={key}>
                <BudgetImpactView impact={part.data} />
              </Card>
            );
          case "data-choices":
            if (pending) return <PendingRow key={key} label={t("chat:preparing.choices")} />;
            return (
              <ChoiceCard
                key={key}
                part={withReplyAnswer(part.data, answerText)}
                onAnswer={onChoice}
                disabled={busy}
              />
            );
          default:
            if (part.type.startsWith("tool-") || part.type === "dynamic-tool") {
              const state = (part as { state?: string }).state;
              if (state === "output-available" || state === "output-error") return null;
              return (
                <Text key={key} variant="caption">
                  {t("chat:working")}
                </Text>
              );
            }
            return null;
        }
      })}
    </View>
  );
}

/**
 * Loads the conversation before `useChat` exists: the encrypted offline copy shows at once (native),
 * the server history replaces it as soon as it arrives. A 404 (the id is unknown to this account)
 * mints a new conversation id once.
 */
export function ChatScreen() {
  const t = useKassaT();
  const hydrated = useChatHydrated();
  const conversationId = useChatStore((s) => s.conversationId);
  const newConversation = useChatStore((s) => s.newConversation);
  const [history, setHistory] = useState<{
    id: string;
    cached?: KassaUIMessage[];
    server?: KassaUIMessage[] | null;
    failed?: boolean;
  } | null>(null);
  const rotated = useRef(false);

  useEffect(() => {
    if (!hydrated) return;
    const ctrl = new AbortController();
    let live = true;
    const patch = (next: Partial<NonNullable<typeof history>>) => {
      if (live) {
        setHistory((h) => ({
          ...(h?.id === conversationId ? h : { id: conversationId }),
          ...next,
        }));
      }
    };
    void readCachedMessages<KassaUIMessage>(conversationId).then((cached) => patch({ cached }));
    fetchConversationMessages(conversationId, ctrl.signal)
      .then((server) => {
        if (!live) return;
        if (server === null && !rotated.current) {
          rotated.current = true;
          newConversation();
          return;
        }
        patch({ server: (server ?? []) as unknown as KassaUIMessage[] });
      })
      .catch(() => patch({ failed: true }));
    return () => {
      live = false;
      ctrl.abort();
    };
  }, [hydrated, conversationId, newConversation]);

  const ready =
    history?.id === conversationId &&
    (history.server !== undefined || history.failed || (history.cached?.length ?? 0) > 0);
  if (!hydrated || !history || !ready) {
    return <Loading label={t("chat:loadingHistory")} />;
  }
  return (
    <ChatSession
      key={conversationId}
      conversationId={conversationId}
      initial={history.server ?? history.cached ?? []}
      server={history.server ?? undefined}
    />
  );
}

function ChatSession({
  conversationId,
  initial: initialProp,
  server,
}: {
  conversationId: string;
  initial: KassaUIMessage[];
  server: KassaUIMessage[] | undefined;
}) {
  const t = useKassaT();
  const { colors } = useTheme();
  const lite = isLiteBuild();
  const newConversation = useChatStore((s) => s.newConversation);
  // What the session started with (cache or server); `server` is compared against it below.
  const [initial] = useState(initialProp);
  const transport = useMemo(() => createAgentTransport(conversationId), [conversationId]);
  const { messages, setMessages, sendMessage, status, error, stop, regenerate } =
    useChat<KassaUIMessage>({
      id: conversationId,
      messages: initial,
      transport,
      ...agentChatSchemas,
    });
  const touched = useRef(false);

  // The server history arrives after the cached copy was shown: it wins, unless the user already
  // started typing to the agent in this session.
  useEffect(() => {
    if (server && server !== initial && !touched.current) setMessages(server);
  }, [server, initial, setMessages]);

  // Offline copy (native; encrypted, last 50): refreshed whenever a reply has settled. The history list
  // (titles, last activity) changes with every turn too.
  const qc = useQueryClient();
  useEffect(() => {
    if (status === "ready" && messages.length > 0) {
      void writeCachedMessages(conversationId, messages);
      void qc.invalidateQueries({ queryKey: keys.conversations });
    }
  }, [status, messages, conversationId, qc]);
  const title = useConversations().data?.conversations.find((c) => c.id === conversationId)?.title;
  const [input, setInput] = useState("");
  const scroll = useRef<ScrollView>(null);
  const busy = status === "submitted" || status === "streaming";
  const setBudgets = useSetBudgets();

  const send = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    haptics.selection();
    setInput("");
    touched.current = true;
    void sendMessage({ text: trimmed });
  };

  const choose = async (a: ChoiceAnswerInput): Promise<boolean> => {
    if (busy) return false;
    haptics.selection();
    if (a.budgets) {
      // The budgets card sets the limits itself (raises need the passkey); the answer only tells the agent.
      try {
        await setBudgets.mutateAsync(a.budgets);
        toast.show({ kind: "success", title: t("chat:budgets.applied") });
      } catch (err) {
        if (!(err instanceof PasskeyCancelledError)) {
          haptics.error();
          toast.show({
            kind: "error",
            title: t("chat:budgets.failed"),
            description: errorText(t, err),
          });
        }
        return false;
      }
    }
    touched.current = true;
    void sendMessage({ text: a.text }, { body: { choice: a.choice } });
    return true;
  };

  return (
    <>
      <Stack.Screen
        options={{
          title: title ?? t("chat:title"),
        }}
      />
      <HeaderButtons
        placement="left"
        buttons={[
          {
            icon: "clock.arrow.circlepath",
            fallback: "history",
            label: t("chat:history.open"),
            onPress: () => router.push("/chat/history" as Href),
            testID: "open-history",
          },
        ]}
      />
      <HeaderButtons
        placement="right"
        buttons={[
          {
            icon: "square.and.pencil",
            fallback: "edit_square",
            label: t("chat:newConversation"),
            onPress: newConversation,
            testID: "new-conversation",
          },
        ]}
      />
      <ChatLayout
        inTabs
        composer={
          <View
            style={{
              flexDirection: "row",
              alignItems: "flex-end",
              gap: 8,
              paddingHorizontal: 12,
              paddingVertical: 8,
              borderTopWidth: 1,
              borderTopColor: colors.border,
              backgroundColor: colors.background,
            }}
          >
            <TextInput
              value={input}
              onChangeText={setInput}
              placeholder={t("chat:placeholder")}
              placeholderTextColor={colors.mutedForeground}
              accessibilityLabel={t("chat:inputA11y")}
              multiline
              maxLength={4000}
              onSubmitEditing={() => send(input)}
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
              onPress={() => (busy ? void stop() : send(input))}
              accessibilityRole="button"
              accessibilityLabel={busy ? t("chat:stop") : t("chat:send")}
              style={{
                width: 44,
                height: 44,
                borderRadius: 22,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: colors.brandAccent,
              }}
            >
              <Icon
                name={busy ? "stop.fill" : "arrow.up"}
                fallback={busy ? "stop" : "arrow_upward"}
                size={20}
                color="primaryForeground"
              />
            </Pressable>
          </View>
        }
      >
        <ScrollView
          ref={scroll}
          contentInsetAdjustmentBehavior="automatic"
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ padding: 16, gap: 16, flexGrow: 1 }}
          onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })}
        >
          {messages.length === 0 ? (
            <Box gap={4} style={{ flex: 1, justifyContent: "center" }}>
              <Text variant="heading" align="center">
                {t("chat:emptyTitle")}
              </Text>
              <Text variant="caption" align="center">
                {lite ? t("chat:emptyBodyLite") : t("chat:emptyBody")}
              </Text>
              <Box gap={2}>
                {(lite ? LITE_SUGGESTIONS : SUGGESTIONS).map((key) => (
                  <Button key={key} variant="outline" onPress={() => send(t(key))}>
                    {t(key)}
                  </Button>
                ))}
              </Box>
            </Box>
          ) : (
            messages.map((m, i) => (
              <MessageParts
                key={m.id}
                message={m}
                pending={status === "streaming" && i === messages.length - 1}
                answerText={laterUserText(messages, i)}
                busy={busy}
                onChoice={choose}
              />
            ))
          )}
          {status === "submitted" ? <Text variant="caption">{t("chat:thinking")}</Text> : null}
          {error && consentNeeded(error) ? (
            <ConsentCard need={consentNeeded(error)!} onGiven={() => void regenerate()} />
          ) : error ? (
            <Card>
              <Box gap={2}>
                <Text color="destructive">{t("chat:error")}</Text>
                <Button variant="outline" size="sm" onPress={() => void regenerate()}>
                  {t("common:retry")}
                </Button>
              </Box>
            </Card>
          ) : null}
        </ScrollView>
      </ChatLayout>
    </>
  );
}
