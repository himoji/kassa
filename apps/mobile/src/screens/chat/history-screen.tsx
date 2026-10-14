import type { ConversationSummary } from "@kassa/shared";
import { router, Stack } from "expo-router";
import { useState } from "react";
import { Alert, Platform, Pressable } from "react-native";

import { useConversations, useDeleteConversation, useRenameConversation } from "@/api/hooks/chat";
import { errorText } from "@/components/kassa/error-text";
import { QueryView } from "@/components/kassa/query-view";
import { ScrollScreen } from "@/components/kassa/scroll-screen";
import { RowGroup } from "@/components/row-group";
import { Box, EmptyState, Icon, Input, Row, Text, toast, useTheme } from "@/components/ui";
import { confirm } from "@/lib/confirm";
import { useFormat } from "@/lib/format";
import { useKassaT } from "@/lib/i18n";
import { HeaderButtons } from "@/navigation/header-buttons";
import { useChatStore } from "@/stores/chat";

type Bucket = "today" | "yesterday" | "week" | "month" | "older";

const DAY = 24 * 60 * 60 * 1000;

/** Local midnight of the day an instant falls on. */
function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function lastActivity(c: ConversationSummary): string {
  return c.lastMessageAt ?? c.createdAt;
}

/** Which date section a chat sits in, by its last activity, relative to `now` (local days). */
export function bucketOf(iso: string, now: Date): Bucket {
  const day = startOfDay(new Date(iso));
  const today = startOfDay(now);
  if (day >= today) return "today";
  if (day >= today - DAY) return "yesterday";
  if (day >= today - 7 * DAY) return "week";
  if (day >= today - 30 * DAY) return "month";
  return "older";
}

/** Chats in date sections (Today, Yesterday, …), newest first, filtered by `query` on the title. */
export function sectionChats(
  chats: readonly ConversationSummary[],
  query: string,
  untitled: string,
  now: Date = new Date()
): { bucket: Bucket; chats: ConversationSummary[] }[] {
  const q = query.trim().toLocaleLowerCase();
  const order: Bucket[] = ["today", "yesterday", "week", "month", "older"];
  const sections = new Map<Bucket, ConversationSummary[]>();
  const sorted = [...chats].sort(
    (a, b) => Date.parse(lastActivity(b)) - Date.parse(lastActivity(a))
  );
  for (const c of sorted) {
    if (q && !(c.title ?? untitled).toLocaleLowerCase().includes(q)) continue;
    const b = bucketOf(lastActivity(c), now);
    sections.set(b, [...(sections.get(b) ?? []), c]);
  }
  return order.filter((b) => sections.has(b)).map((b) => ({ bucket: b, chats: sections.get(b)! }));
}

function ChatRow({
  chat,
  current,
  onOpen,
  onActions,
  onRename,
  onDelete,
}: {
  chat: ConversationSummary;
  current: boolean;
  onOpen: () => void;
  onActions: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const t = useKassaT();
  const f = useFormat();
  const name = chat.title ?? t("chat:history.untitled");
  const iconButton = (sf: string, md: string, label: string, onPress: () => void) => (
    <Pressable
      key={sf}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={8}
      style={{ minWidth: 36, minHeight: 36, alignItems: "center", justifyContent: "center" }}
    >
      <Icon name={sf} fallback={md} size={18} color="mutedForeground" />
    </Pressable>
  );
  const at = lastActivity(chat);
  const today = bucketOf(at, new Date()) === "today";
  return (
    <Row
      testID={`chat-${chat.id}`}
      leading={
        <Icon
          name={current ? "bubble.left.and.bubble.right.fill" : "bubble.left.and.bubble.right"}
          fallback="forum"
          size={20}
          color={current ? "brandAccent" : "mutedForeground"}
        />
      }
      title={name}
      subtitle={[
        today ? f.time(at) : f.dayMonth(at),
        chat.messageCount !== undefined
          ? t("chat:history.messages", { count: chat.messageCount })
          : null,
        current ? t("chat:history.current") : null,
      ]
        .filter(Boolean)
        .join(" · ")}
      onPress={onOpen}
      onLongPress={onActions}
      trailing={
        Platform.OS === "web" ? (
          <Box row gap={1}>
            {iconButton("pencil", "edit", t("chat:history.renameA11y", { title: name }), onRename)}
            {iconButton("trash", "delete", t("chat:history.deleteA11y", { title: name }), onDelete)}
          </Box>
        ) : (
          iconButton(
            "ellipsis",
            "more_horiz",
            t("chat:history.actions", { title: name }),
            onActions
          )
        )
      }
    />
  );
}

/** Rename in place: the row becomes a field; return saves, an empty title keeps the old one. */
function RenameRow({ chat, onDone }: { chat: ConversationSummary; onDone: () => void }) {
  const t = useKassaT();
  const rename = useRenameConversation();
  const [title, setTitle] = useState(chat.title ?? "");
  const save = () => {
    const next = title.trim();
    if (!next || next === chat.title) return onDone();
    rename.mutate(
      { id: chat.id, title: next.slice(0, 80) },
      {
        onSuccess: onDone,
        onError: (err) => toast.show({ kind: "error", title: errorText(t, err) }),
      }
    );
  };
  return (
    <Box p={3}>
      <Input
        value={title}
        onChangeText={setTitle}
        label={t("chat:history.renameLabel")}
        autoFocus
        maxLength={80}
        returnKeyType="done"
        onSubmitEditing={save}
        testID="rename-input"
      />
    </Box>
  );
}

/**
 * Every chat with the assistant: search by title, sections by last activity, the open one marked. Tap opens a
 * chat, long-press or ••• renames or deletes it. "New chat" starts a fresh conversation.
 */
export function ChatHistoryScreen() {
  const t = useKassaT();
  const { colors } = useTheme();
  const list = useConversations();
  const remove = useDeleteConversation();
  const conversationId = useChatStore((s) => s.conversationId);
  const setConversationId = useChatStore((s) => s.setConversationId);
  const newConversation = useChatStore((s) => s.newConversation);
  const [query, setQuery] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);

  const open = (id: string) => {
    setConversationId(id);
    if (router.canGoBack()) router.back();
  };
  const startNew = () => {
    newConversation();
    if (router.canGoBack()) router.back();
  };
  const del = async (chat: ConversationSummary) => {
    const ok = await confirm({
      title: t("chat:history.deleteTitle"),
      message: t("chat:history.deleteBody", { title: chat.title ?? t("chat:history.untitled") }),
      confirmLabel: t("chat:history.delete"),
      cancelLabel: t("common:cancel"),
      destructive: true,
    });
    if (!ok) return;
    remove.mutate(chat.id, {
      onSuccess: () => {
        if (chat.id === conversationId) newConversation();
        toast.show({ kind: "success", title: t("chat:history.deleted") });
      },
      onError: (err) => toast.show({ kind: "error", title: errorText(t, err) }),
    });
  };
  /** Native action sheet (long-press or •••); web shows rename and delete buttons on the row instead. */
  const actions = (chat: ConversationSummary) => {
    if (Platform.OS === "web") return setRenaming(chat.id);
    Alert.alert(chat.title ?? t("chat:history.untitled"), undefined, [
      { text: t("chat:history.rename"), onPress: () => setRenaming(chat.id) },
      { text: t("chat:history.delete"), style: "destructive", onPress: () => void del(chat) },
      { text: t("common:cancel"), style: "cancel" },
    ]);
  };

  return (
    <>
      <Stack.Screen
        options={{
          headerSearchBarOptions:
            Platform.OS === "web"
              ? undefined
              : {
                  placeholder: t("chat:history.search"),
                  onChangeText: (e) => setQuery(e.nativeEvent.text),
                  hideWhenScrolling: false,
                },
        }}
      />
      <HeaderButtons
        placement="right"
        buttons={[
          {
            icon: "square.and.pencil",
            fallback: "edit_square",
            label: t("chat:newConversation"),
            onPress: startNew,
          },
        ]}
      />
      <ScrollScreen onRefresh={() => void list.refetch()} refreshing={list.isRefetching}>
        {Platform.OS === "web" ? (
          <Input
            value={query}
            onChangeText={setQuery}
            placeholder={t("chat:history.search")}
            returnKeyType="search"
            leftIcon={
              <Icon name="magnifyingglass" fallback="search" size={16} color="mutedForeground" />
            }
          />
        ) : null}
        <RowGroup icons>
          <Row
            leading={
              <Icon name="plus.bubble.fill" fallback="add_comment" size={22} color="brandAccent" />
            }
            title={t("chat:history.newChat")}
            onPress={startNew}
            testID="new-chat"
          />
        </RowGroup>
        <QueryView
          query={list}
          skeletonRows={5}
          isEmpty={(d) => d.conversations.length === 0}
          empty={
            <EmptyState
              title={t("chat:history.emptyTitle")}
              description={t("chat:history.emptyBody")}
            />
          }
        >
          {(d) => {
            const sections = sectionChats(d.conversations, query, t("chat:history.untitled"));
            if (sections.length === 0) {
              return <EmptyState title={t("chat:history.noMatch", { query: query.trim() })} />;
            }
            return (
              <>
                {sections.map((s) => (
                  <RowGroup key={s.bucket} icons title={t(`chat:history.bucket.${s.bucket}`)}>
                    {s.chats.map((c) =>
                      renaming === c.id ? (
                        <RenameRow key={c.id} chat={c} onDone={() => setRenaming(null)} />
                      ) : (
                        <ChatRow
                          key={c.id}
                          chat={c}
                          current={c.id === conversationId}
                          onOpen={() => open(c.id)}
                          onActions={() => actions(c)}
                          onRename={() => setRenaming(c.id)}
                          onDelete={() => void del(c)}
                        />
                      )
                    )}
                  </RowGroup>
                ))}
                <Text variant="caption" align="center" style={{ color: colors.mutedForeground }}>
                  {t("chat:history.footer", { count: d.conversations.length })}
                </Text>
              </>
            );
          }}
        </QueryView>
      </ScrollScreen>
    </>
  );
}
