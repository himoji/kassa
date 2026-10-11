import { useChat } from "@ai-sdk/react";
import { Stack } from "expo-router";
import { useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";

import { agentChatSchemas, createAgentTransport, type KassaUIMessage } from "@/api/agent-transport";
import { useMe } from "@/api/hooks/me";
import { ReplayBadge } from "@/components/kassa/badges";
import { BudgetImpactView } from "@/components/kassa/budget-impact";
import { ProposalCard } from "@/components/kassa/proposal-card";
import { RouteComparison } from "@/components/kassa/route-comparison";
import { Box, Button, Card, Icon, Text, useTheme } from "@/components/ui";
import { haptics } from "@/lib/haptics";
import { useKassaT } from "@/lib/i18n";
import { useChatStore } from "@/stores/chat";

import { consentNeeded } from "./consent";
import { ConsentCard } from "./consent-card";

const SUGGESTIONS = ["chat:suggest.tuition", "chat:suggest.budget", "chat:suggest.log"] as const;

function MessageParts({ message }: { message: KassaUIMessage }) {
  const t = useKassaT();
  const { colors } = useTheme();
  const mine = message.role === "user";
  return (
    <View style={{ gap: 8, alignItems: mine ? "flex-end" : "stretch" }}>
      {message.metadata?.replay ? <ReplayBadge force /> : null}
      {message.parts.map((part, i) => {
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
                <Text selectable style={mine ? { color: "#ffffff" } : undefined}>
                  {part.text}
                </Text>
              </View>
            );
          case "data-proposal":
            return <ProposalCard key={key} proposal={part.data} />;
          case "data-routes":
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
            return (
              <Card key={key}>
                <BudgetImpactView impact={part.data} />
              </Card>
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

export function ChatScreen() {
  const t = useKassaT();
  const { colors } = useTheme();
  const conversationId = useChatStore((s) => s.conversationId);
  const newConversation = useChatStore((s) => s.newConversation);
  const transport = useMemo(() => createAgentTransport(conversationId), [conversationId]);
  const { messages, sendMessage, status, error, stop, regenerate } = useChat<KassaUIMessage>({
    id: conversationId,
    transport,
    ...agentChatSchemas,
  });
  const [input, setInput] = useState("");
  const scroll = useRef<ScrollView>(null);
  const busy = status === "submitted" || status === "streaming";
  const replay = useMe().data?.demo?.agentMode === "REPLAY";

  const send = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    haptics.selection();
    setInput("");
    void sendMessage({ text: trimmed });
  };

  return (
    <>
      <Stack.Screen
        options={{
          headerRight: () => (
            <Box row gap={2} align="center">
              {replay ? <ReplayBadge /> : null}
              <Pressable
                onPress={newConversation}
                accessibilityRole="button"
                accessibilityLabel={t("chat:newConversation")}
                style={{
                  minWidth: 44,
                  minHeight: 44,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Icon name="square.and.pencil" fallback="edit_square" size={22} />
              </Pressable>
            </Box>
          ),
        }}
      />
      <KeyboardAvoidingView
        behavior="padding"
        style={{ flex: 1, backgroundColor: colors.background }}
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
                {t("chat:emptyBody")}
              </Text>
              <Box gap={2}>
                {SUGGESTIONS.map((key) => (
                  <Button key={key} variant="outline" onPress={() => send(t(key))}>
                    {t(key)}
                  </Button>
                ))}
              </Box>
            </Box>
          ) : (
            messages.map((m) => <MessageParts key={m.id} message={m} />)
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
      </KeyboardAvoidingView>
    </>
  );
}
