import type { AgentOutcome, CardDto, RecentCapture, TransactionDto } from "@kassa/shared";
import { router, Stack, type Href } from "expo-router";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Platform,
  Pressable,
  ScrollView,
  useWindowDimensions,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";

import { useSpendingInsights } from "@/api/hooks/insights";
import { useMe } from "@/api/hooks/me";
import {
  useAgentActivity,
  useBalances,
  useBudgets,
  useCardFees,
  useCards,
  useTransactions,
  useObligations,
  usePendingProposals,
} from "@/api/hooks/money";
import { usePayees } from "@/api/hooks/payees";
import { FreezeButton } from "@/components/kassa/freeze-button";
import { ObligationRow } from "@/components/kassa/obligation-row";
import { ProposalCard } from "@/components/kassa/proposal-card";
import { ScrollScreen } from "@/components/kassa/scroll-screen";
import { CategoryAvatar, categoryLabel } from "@/components/kassa/spend-charts";
import { StatusChip } from "@/components/kassa/status-chip";
import { RowGroup } from "@/components/row-group";
import { Box, Card, Icon, Row, Text, useTheme } from "@/components/ui";
import { useFormat } from "@/lib/format";
import { haptics } from "@/lib/haptics";
import { useKassaT } from "@/lib/i18n";
import { useDataMode, visibleCaptures } from "@/lite/data-mode";
import { isLiteBuild } from "@/lite/variant";
import { useRecentCaptures } from "@/lite/use-recent-captures";
import { PayTo } from "@/screens/home/home-screen";
import { CaptureRow, cardName, sortCaptures } from "@/screens/lite/activity-screen";
import { statusColor, type StatusTone } from "@/theme/status";

/** Space between deck cards, and how far the deck sits from the screen edge. */
const GAP = 12;
const EDGE = 16;
/** The deck card is this much narrower than the screen, so the next one peeks in. */
const PEEK = 48;
const CARD_HEIGHT = 200;
/** Widest a deck card gets (a wide web window). */
const CARD_MAX = 400;
/** ScrollScreen's web column (scroll-screen.tsx): the deck measures itself, this is only the first guess. */
const WEB_MAX = 760;
/** Rows a section shows before "See all". */
const SECTION_ROWS = 3;
/** Characters of a card's name on its chip. */
const CHIP_LABEL = 12;

const ON_HERO = "#ffffff";
const ON_HERO_MUTED = "rgba(255,255,255,0.72)";

type Gradient = readonly [string, string];
const ALL_GRADIENT: Gradient = ["#0E9F73", "#04503A"];
const KASSA_GRADIENT: Gradient = ["#6366F1", "#4C1D95"];
const WALLET_GRADIENT: Gradient = ["#0F766E", "#134E4A"];
/** Card pages pick one by their id, so a card keeps its colour. */
const CARD_GRADIENTS: readonly Gradient[] = [
  ["#334155", "#0F172A"],
  ["#0E7490", "#164E63"],
  ["#C2410C", "#7C2D12"],
  ["#BE185D", "#831843"],
  ["#1D4ED8", "#1E3A8A"],
  ["#4D7C0F", "#365314"],
];

export function cardGradient(id: string): Gradient {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return CARD_GRADIENTS[h % CARD_GRADIENTS.length]!;
}

type Page =
  | { kind: "all" }
  | { kind: "wallet" }
  | { kind: "card"; card: CardDto }
  | { kind: "kassa" }
  | { kind: "add" };

function pageKey(p: Page): string {
  return p.kind === "card" ? `card-${p.card.id}` : p.kind;
}

/** Whether an instant falls in the current local calendar month. */
function inThisMonth(iso: string, now = new Date()): boolean {
  const d = new Date(iso);
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
}

/** What one card's purchases this month come to (home currency; purchases not converted yet left out). */
export function cardMonth(
  captures: readonly RecentCapture[],
  cardId: string,
  now = new Date()
): { spentHomeMinor: number; count: number; captures: RecentCapture[] } {
  const month = captures.filter((c) => c.cardId === cardId && inThisMonth(c.occurredAt, now));
  return {
    spentHomeMinor: month.reduce((s, c) => s + (c.homeAmountMinor ?? 0), 0),
    count: month.length,
    captures: month,
  };
}

/** Most spent first, in the home currency (null category counted as one). */
export function topCategories(
  captures: readonly RecentCapture[],
  limit = SECTION_ROWS
): { category: string | null; spentHomeMinor: number }[] {
  const by = new Map<string | null, number>();
  for (const c of captures)
    by.set(c.category, (by.get(c.category) ?? 0) + (c.homeAmountMinor ?? 0));
  return [...by.entries()]
    .map(([category, spentHomeMinor]) => ({ category, spentHomeMinor }))
    .sort((a, b) => b.spentHomeMinor - a.spentHomeMinor)
    .slice(0, limit);
}

/** A rounded deck card on a diagonal gradient. Pixel-sized Svg: percentage sizes collapse on iOS. */
function DeckCard({
  id,
  gradient,
  width,
  children,
}: {
  id: string;
  gradient: Gradient;
  width: number;
  children: ReactNode;
}) {
  return (
    <View
      style={{
        width,
        // A web row would otherwise shrink a card whose text can ellipsize (the All card) below the others; some
        // browsers ignore flexShrink there, so the width is pinned both ways.
        minWidth: width,
        maxWidth: width,
        flexShrink: 0,
        height: CARD_HEIGHT,
        borderRadius: 24,
        overflow: "hidden",
        padding: CARD_PADDING,
        justifyContent: "space-between",
        backgroundColor: gradient[1],
      }}
    >
      <Svg style={{ position: "absolute", top: 0, left: 0 }} width={width} height={CARD_HEIGHT}>
        <Defs>
          <LinearGradient id={`deck-${id}`} x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor={gradient[0]} />
            <Stop offset="1" stopColor={gradient[1]} />
          </LinearGradient>
        </Defs>
        <Rect width={width} height={CARD_HEIGHT} fill={`url(#deck-${id})`} />
      </Svg>
      {children}
    </View>
  );
}

/** Round action on the All card: white disc, brand-green glyph, label below (home-screen HeroAction, smaller). */
function HeroAction({
  label,
  sf,
  md,
  onPress,
}: {
  label: string;
  sf: string;
  md: string;
  onPress: () => void;
}) {
  return (
    <View style={{ width: "25%", alignItems: "center" }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        onPress={onPress}
        hitSlop={8}
        style={{ alignItems: "center", gap: 4, width: "100%", paddingHorizontal: 2 }}
      >
        <View
          style={{
            width: 44,
            height: 44,
            borderRadius: 22,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: ON_HERO,
          }}
        >
          <Icon name={sf} fallback={md} size={20} color="#056347" />
        </View>
        <Text
          weight="semibold"
          numberOfLines={1}
          style={{ color: ON_HERO, fontSize: 11, textAlign: "center", width: "100%" }}
        >
          {label}
        </Text>
      </Pressable>
    </View>
  );
}

/** Padding inside a deck card (DeckCard). */
const CARD_PADDING = 20;

/**
 * The big amount steps down for long figures and narrow cards, so "KZT 1,234,567.89" fits whole: a bold digit is
 * about 0.62 em wide.
 */
export function amountSize(text: string, cardWidth = 340): number {
  const room = Math.max(120, cardWidth - CARD_PADDING * 2);
  return Math.max(20, Math.min(34, Math.floor(room / (Math.max(1, text.length) * 0.62))));
}

/** A deck card's big figure, sized from the room it really gets (measured), so it never ends in "…". */
function HeroAmount({ text, width }: { text: string; width: number }) {
  const [room, setRoom] = useState<number | null>(null);
  return (
    <View onLayout={(e) => setRoom(e.nativeEvent.layout.width)} style={{ width: "100%" }}>
      <Text
        variant="title"
        numberOfLines={1}
        style={{
          color: ON_HERO,
          fontSize: amountSize(text, room === null ? width : room + CARD_PADDING * 2),
          lineHeight: 40,
          letterSpacing: -0.8,
          fontVariant: ["tabular-nums"],
        }}
      >
        {text}
      </Text>
    </View>
  );
}

/** Spending this month across everything, what the budgets leave, and the three money actions. */
function AllCard({ width }: { width: number }) {
  const t = useKassaT();
  const f = useFormat();
  const insights = useSpendingInsights().data;
  const budgets = useBudgets().data;
  const list = budgets?.budgets ?? [];
  const left =
    list.reduce((s, b) => s + b.limitHomeMinor, 0) - list.reduce((s, b) => s + b.spentHomeMinor, 0);
  const daysLeft = list[0]?.daysLeft ?? insights?.month.daysLeft;
  const total = insights ? f.money(insights.totalMinor, insights.homeCurrency) : "—";
  const line = [
    budgets && list.length > 0
      ? t("lite:home.leftInBudgets", { amount: f.money(left, budgets.homeCurrency) })
      : null,
    daysLeft !== undefined ? t("lite:home.daysLeft", { count: daysLeft }) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <DeckCard id="all" gradient={ALL_GRADIENT} width={width}>
      <Box gap={1}>
        <Box row justify="between" align="center">
          <Text style={{ color: ON_HERO_MUTED, fontSize: 14 }}>
            {insights
              ? t("lite:home.spentIn", { month: f.monthName(insights.month.start) })
              : t("lite:home.spentThisMonth")}
          </Text>
        </Box>
        <HeroAmount text={total} width={width} />
        {line ? (
          <Text numberOfLines={1} style={{ color: ON_HERO_MUTED, fontSize: 13 }}>
            {line}
          </Text>
        ) : null}
      </Box>
      <View style={{ flexDirection: "row", width: "100%" }}>
        <HeroAction
          label={t("home:addMoney")}
          sf="plus"
          md="add"
          onPress={() => router.push("/add-money")}
        />
        <HeroAction
          label={t("home:send")}
          sf="paperplane.fill"
          md="send"
          onPress={() => router.push("/send")}
        />
        <HeroAction
          label={t("home:convert")}
          sf="arrow.left.arrow.right"
          md="currency_exchange"
          onPress={() => router.push("/convert")}
        />
        <HeroAction
          label={t("settings:importScreen.tile")}
          sf="doc.text"
          md="description"
          onPress={() => router.push("/import" as Href)}
        />
      </View>
    </DeckCard>
  );
}

/** The Kassa wallet: what it holds in the home currency and per currency (GET /balances). */
function WalletCard({ width }: { width: number }) {
  const t = useKassaT();
  const f = useFormat();
  const b = useBalances().data;
  const total = b ? f.money(b.homeTotalMinor, b.homeCurrency) : "—";
  const held = (b?.balances ?? []).filter((x) => x.amountMinor !== 0);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${t("lite:home.wallet")}: ${total}`}
      onPress={() => router.push("/add-money")}
      style={{ width, minWidth: width, flexShrink: 0 }}
    >
      <DeckCard id="wallet" gradient={WALLET_GRADIENT} width={width}>
        <Box row justify="between" align="center" gap={3}>
          <Text
            weight="semibold"
            numberOfLines={1}
            style={{ color: ON_HERO, fontSize: 17, flex: 1 }}
          >
            {t("lite:home.wallet")}
          </Text>
          <Icon
            name="wallet.pass.fill"
            fallback="account_balance_wallet"
            size={22}
            color="#ffffffb8"
          />
        </Box>
        <Box gap={1}>
          <Text style={{ color: ON_HERO_MUTED, fontSize: 14 }}>{t("lite:home.walletTotal")}</Text>
          <HeroAmount text={total} width={width} />
          <Text numberOfLines={1} style={{ color: ON_HERO_MUTED, fontSize: 13 }}>
            {held.length > 0
              ? held.map((x) => f.money(x.amountMinor, x.currency)).join(" · ")
              : t("lite:home.walletEmpty")}
          </Text>
        </Box>
      </DeckCard>
    </Pressable>
  );
}

/** Below the Wallet card: each balance, and the money actions. */
function WalletDetails() {
  const t = useKassaT();
  const f = useFormat();
  const b = useBalances().data;
  const rows = (b?.balances ?? []).filter((x) => x.amountMinor !== 0);
  return (
    <>
      <RowGroup title={t("lite:home.walletBalances")} icons>
        {rows.length === 0 ? (
          <Row title={t("lite:home.walletEmpty")} />
        ) : (
          rows.map((x) => (
            <Row
              key={x.currency}
              leading={<Icon name="banknote" fallback="payments" size={20} color="foreground" />}
              title={x.currency}
              subtitle={
                b && x.currency !== b.homeCurrency
                  ? `≈ ${f.money(x.homeAmountMinor, b.homeCurrency)}`
                  : undefined
              }
              trailing={
                <Text weight="semibold" style={{ fontVariant: ["tabular-nums"] }}>
                  {f.money(x.amountMinor, x.currency)}
                </Text>
              }
            />
          ))
        )}
      </RowGroup>
      <RowGroup icons>
        <Row
          leading={<Icon name="plus.circle" fallback="add_circle" size={20} color="foreground" />}
          title={t("home:addMoney")}
          onPress={() => router.push("/add-money")}
        />
        <Row
          leading={<Icon name="paperplane" fallback="send" size={20} color="foreground" />}
          title={t("home:send")}
          onPress={() => router.push("/send")}
        />
        <Row
          leading={
            <Icon
              name="arrow.left.arrow.right"
              fallback="currency_exchange"
              size={20}
              color="foreground"
            />
          }
          title={t("home:convert")}
          onPress={() => router.push("/convert")}
        />
      </RowGroup>
    </>
  );
}

/** One card: its name and digits, what was spent on it this month and how many purchases. */
function CardPage({
  card,
  width,
  captures,
  matched,
  homeCurrency,
}: {
  card: CardDto;
  width: number;
  captures: readonly RecentCapture[];
  /** False when the server sends no card on any purchase (an older server): the total is unknown. */
  matched: boolean;
  homeCurrency: string | undefined;
}) {
  const t = useKassaT();
  const f = useFormat();
  const month = cardMonth(captures, card.id);
  const digits = `•• ${card.last4}`;
  return (
    <DeckCard id={card.id} gradient={cardGradient(card.id)} width={width}>
      <Box row justify="between" align="center" gap={3}>
        <Text weight="semibold" numberOfLines={1} style={{ color: ON_HERO, fontSize: 17, flex: 1 }}>
          {card.label}
        </Text>
        <Icon name="creditcard.fill" fallback="credit_card" size={22} color="#ffffffb8" />
      </Box>
      <Box gap={1}>
        <Text style={{ color: ON_HERO_MUTED, fontSize: 14 }}>{t("lite:home.cardSpent")}</Text>
        <Text
          variant="title"
          numberOfLines={1}
          style={{
            color: ON_HERO,
            fontSize: 30,
            lineHeight: 36,
            letterSpacing: -0.6,
            fontVariant: ["tabular-nums"],
          }}
        >
          {matched && homeCurrency ? f.money(month.spentHomeMinor, homeCurrency) : "—"}
        </Text>
        <Box row justify="between" align="center">
          <Text style={{ color: ON_HERO_MUTED, fontSize: 13 }}>
            {matched ? t("lite:home.purchases", { count: month.count }) : ""}
          </Text>
          {card.last4 ? (
            <Text
              weight="semibold"
              style={{ color: ON_HERO, letterSpacing: 1, fontVariant: ["tabular-nums"] }}
            >
              {digits}
            </Text>
          ) : null}
        </Box>
      </Box>
    </DeckCard>
  );
}

/** Paid inside a mandate or after the passkey, drafted and waiting for it, held by the rules. */
function agentCounts(counts: Partial<Record<AgentOutcome, number>>) {
  return {
    paid: (counts.PAID_AUTO ?? 0) + (counts.PAID_APPROVED ?? 0),
    drafted: counts.WAITING ?? 0,
    blocked: counts.HELD ?? 0,
  };
}

/** What Kassa did this week, in three numbers, and how many orders wait for the passkey. */
function KassaCard({ width }: { width: number }) {
  const t = useKassaT();
  const activity = useAgentActivity().data;
  const pending = usePendingProposals().data?.proposals.length ?? 0;
  const c = activity ? agentCounts(activity.counts) : null;
  const counter = (n: number | undefined, label: string) => (
    <Box flex={1} gap={1}>
      <Text
        variant="title"
        style={{ color: ON_HERO, fontSize: 28, lineHeight: 34, fontVariant: ["tabular-nums"] }}
      >
        {n === undefined ? "—" : String(n)}
      </Text>
      <Text numberOfLines={1} style={{ color: ON_HERO_MUTED, fontSize: 13 }}>
        {label}
      </Text>
    </Box>
  );
  return (
    <DeckCard id="kassa" gradient={KASSA_GRADIENT} width={width}>
      <Box row align="center" gap={2}>
        <Icon name="sparkles" fallback="auto_awesome" size={18} color={ON_HERO} />
        <Text weight="semibold" numberOfLines={1} style={{ color: ON_HERO, flex: 1 }}>
          {t("lite:home.kassaTitle")}
        </Text>
      </Box>
      <Box row gap={3}>
        {counter(c?.paid, t("lite:home.paid"))}
        {counter(c?.drafted, t("lite:home.drafted"))}
        {counter(c?.blocked, t("lite:home.blocked"))}
      </Box>
      <Box row>
        {pending > 0 ? (
          <View
            style={{
              borderRadius: 999,
              paddingHorizontal: 12,
              paddingVertical: 5,
              backgroundColor: "rgba(255,255,255,0.18)",
            }}
          >
            <Text weight="semibold" style={{ color: ON_HERO, fontSize: 13 }}>
              {t("lite:home.toSign", { count: pending })}
            </Text>
          </View>
        ) : (
          <Text style={{ color: ON_HERO_MUTED, fontSize: 13 }}>{t("lite:home.kassaFooter")}</Text>
        )}
      </Box>
    </DeckCard>
  );
}

/** The last page: a dashed outline that adds a card by hand. */
function AddCardPage({ width }: { width: number }) {
  const t = useKassaT();
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("lite:home.addCard")}
      onPress={() => router.push("/cards?add=1" as Href)}
      style={{
        width,
        flexShrink: 0,
        height: CARD_HEIGHT,
        borderRadius: 24,
        borderWidth: 2,
        borderStyle: "dashed",
        borderColor: colors.mutedForeground,
        alignItems: "center",
        justifyContent: "center",
        gap: 10,
      }}
    >
      <View
        style={{
          width: 52,
          height: 52,
          borderRadius: 26,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: colors.muted,
        }}
      >
        <Icon name="plus" fallback="add" size={26} color="foreground" />
      </View>
      <Text weight="semibold">{t("lite:home.addCard")}</Text>
    </Pressable>
  );
}

/** A section title with "See all ›" on the right. */
function SectionHeader({ title, onSeeAll }: { title: string; onSeeAll?: () => void }) {
  const t = useKassaT();
  return (
    <Box row justify="between" align="center" px={4}>
      <Text variant="label" color="mutedForeground">
        {title}
      </Text>
      {onSeeAll ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${title}: ${t("lite:home.seeAll")}`}
          onPress={onSeeAll}
          hitSlop={10}
          style={{ flexDirection: "row", alignItems: "center", gap: 2 }}
        >
          <Text variant="caption" weight="semibold" color="brandAccent">
            {t("lite:home.seeAll")}
          </Text>
          <Icon name="chevron.forward" fallback="chevron_right" size={14} color="brandAccent" />
        </Pressable>
      ) : null}
    </Box>
  );
}

function Section({
  title,
  onSeeAll,
  children,
}: {
  title: string;
  onSeeAll?: () => void;
  children: ReactNode;
}) {
  return (
    <Box gap={2}>
      <SectionHeader title={title} onSeeAll={onSeeAll} />
      {children}
    </Box>
  );
}

/** The first order waiting for the passkey, and how many more there are. */
function ToSign({ max, onMore }: { max: number; onMore?: () => void }) {
  const t = useKassaT();
  const proposals = usePendingProposals().data?.proposals ?? [];
  if (proposals.length === 0) return null;
  const more = proposals.length - max;
  return (
    <Box gap={2}>
      <SectionHeader title={t("home:toSign")} />
      {proposals.slice(0, max).map((p) => (
        <ProposalCard key={p.proposalId} proposal={p} />
      ))}
      {more > 0 && onMore ? (
        <Pressable accessibilityRole="button" onPress={onMore} hitSlop={8}>
          <Text variant="caption" weight="semibold" color="brandAccent" align="center">
            {t("lite:home.moreToSign", { count: more })}
          </Text>
        </Pressable>
      ) : null}
    </Box>
  );
}

function Thin({ ratio, tone }: { ratio: number; tone: StatusTone }) {
  const { colors, mode } = useTheme();
  return (
    <View style={{ height: 6, borderRadius: 3, backgroundColor: colors.muted, overflow: "hidden" }}>
      <View
        style={{
          width: `${Math.min(100, Math.max(0, ratio * 100))}%`,
          height: 6,
          borderRadius: 3,
          backgroundColor: statusColor(tone, mode),
        }}
      />
    </View>
  );
}

/** All the budgets as one bar with one chip; the list is in Insights. Hidden without budgets. */
function BudgetsSection() {
  const t = useKassaT();
  const f = useFormat();
  const data = useBudgets().data;
  if (!data || data.budgets.length === 0) return null;
  const limit = data.budgets.reduce((s, b) => s + b.limitHomeMinor, 0);
  const spent = data.budgets.reduce((s, b) => s + b.spentHomeMinor, 0);
  const over = spent > limit || data.budgets.some((b) => b.pace === "OVER");
  const fast = data.budgets.some((b) => b.pace === "AHEAD_OF_PACE");
  const tone: StatusTone = over ? "critical" : fast ? "warning" : "positive";
  const open = () => router.push("/insights" as Href);
  return (
    <Section title={t("lite:home.budgets")} onSeeAll={open}>
      <Card onPress={open}>
        <Box gap={2}>
          <Box row justify="between" align="center" gap={3}>
            <Text weight="semibold" numberOfLines={1} style={{ flexShrink: 1 }}>
              {t("home:spentOf", {
                spent: f.money(spent, data.homeCurrency),
                limit: f.money(limit, data.homeCurrency),
              })}
            </Text>
            <StatusChip tone={tone} label={over ? t("lite:home.over") : t("lite:home.onTrack")} />
          </Box>
          <Thin ratio={limit > 0 ? spent / limit : 1} tone={tone} />
        </Box>
      </Card>
    </Section>
  );
}

/** The next bill due; hidden when there is none. */
function UpcomingSection() {
  const t = useKassaT();
  const data = useObligations().data;
  const homeCurrency = useMe().data?.homeCurrency ?? "KZT";
  const next = data
    ? [...data.obligations].sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0]
    : undefined;
  if (!next) return null;
  return (
    <Section title={t("lite:home.upcoming")} onSeeAll={() => router.push("/bills")}>
      <RowGroup>
        <ObligationRow obligation={next} homeCurrency={homeCurrency} />
      </RowGroup>
    </Section>
  );
}

/** Fees, wrong-currency charges and payees on hold (home-screen Alerts); nothing when all is well. */
function Alerts() {
  const t = useKassaT();
  const f = useFormat();
  const fees = useCardFees().data;
  const payees = usePayees().data;
  const cooling = payees?.payees.filter((p) => p.status === "COOLING") ?? [];
  const blocked = payees?.payees.filter((p) => p.status === "BLOCKED") ?? [];
  const feeLost = fees?.monthlyFeesLostHomeMinor ?? 0;
  const dcc = fees?.dccWarnings.length ?? 0;
  if (feeLost <= 0 && dcc === 0 && cooling.length === 0 && blocked.length === 0) return null;
  return (
    <RowGroup title={t("home:alerts")} icons>
      {feeLost > 0 && fees ? (
        <Row
          leading={<Icon name="percent" fallback="percent" size={20} color="foreground" />}
          title={t("home:alertFees", { amount: f.money(feeLost, fees.homeCurrency) })}
          subtitle={t("home:alertFeesHint")}
          onPress={() => router.push("/cards")}
        />
      ) : null}
      {dcc > 0 ? (
        <Row
          leading={
            <Icon name="exclamationmark.triangle" fallback="warning" size={20} color="foreground" />
          }
          title={t("home:alertDcc", { count: dcc })}
          onPress={() => router.push("/cards")}
        />
      ) : null}
      {cooling.length > 0 ? (
        <Row
          leading={<Icon name="clock" fallback="schedule" size={20} color="foreground" />}
          title={t("home:alertCooling", { count: cooling.length })}
          subtitle={t("home:alertCoolingHint")}
          onPress={() => router.push("/payees")}
        />
      ) : null}
      {blocked.length > 0 ? (
        <Row
          leading={<Icon name="nosign" fallback="block" size={20} color="destructive" />}
          title={t("home:alertBlocked", { count: blocked.length })}
          onPress={() => router.push("/payees")}
        />
      ) : null}
    </RowGroup>
  );
}

/** Under the All card: what to sign, the latest purchases, the budgets in one line, the next bill. */
function AllDetails({ captures, onMore }: { captures: RecentCapture[]; onMore: () => void }) {
  const t = useKassaT();
  const recent = sortCaptures(captures).slice(0, SECTION_ROWS);
  return (
    <>
      <ToSign max={1} onMore={onMore} />
      <Section title={t("lite:home.recent")} onSeeAll={() => router.navigate("/activity" as Href)}>
        <RowGroup icons>
          {recent.length > 0 ? (
            recent.map((c) => <CaptureRow key={c.id} capture={c} dated />)
          ) : (
            <Box p={4}>
              <Text variant="caption">{t("lite:activity.empty")}</Text>
            </Box>
          )}
        </RowGroup>
      </Section>
      <BudgetsSection />
      <UpcomingSection />
      <Alerts />
    </>
  );
}

/** Under a card: its latest purchases and where this month's money on it went. */
function CardDetails({
  card,
  captures,
  homeCurrency,
}: {
  card: CardDto;
  captures: readonly RecentCapture[];
  homeCurrency: string | undefined;
}) {
  const t = useKassaT();
  const f = useFormat();
  const mine = sortCaptures(captures.filter((c) => c.cardId === card.id));
  const month = cardMonth(captures, card.id);
  const top = topCategories(month.captures);
  if (mine.length === 0)
    return (
      <Box px={4}>
        <Text variant="caption">{t("lite:home.cardEmpty")}</Text>
      </Box>
    );
  return (
    <>
      <Section
        title={t("lite:home.recentOnCard")}
        onSeeAll={() => router.navigate(`/activity?card=${encodeURIComponent(card.id)}` as Href)}
      >
        <RowGroup icons>
          {mine.slice(0, SECTION_ROWS).map((c) => (
            <CaptureRow key={c.id} capture={c} dated />
          ))}
        </RowGroup>
      </Section>
      {top.length > 0 && homeCurrency ? (
        <Section title={t("lite:home.topCategories")}>
          <RowGroup icons>
            {top.map((c) => (
              <Box key={c.category ?? "none"} px={4} py={3} row align="center" gap={3}>
                <CategoryAvatar category={c.category} size={32} />
                <Text numberOfLines={1} style={{ flex: 1 }}>
                  {c.category ? categoryLabel(t, c.category) : t("lite:activity.uncategorised")}
                </Text>
                <Text weight="semibold" style={{ fontVariant: ["tabular-nums"] }}>
                  {f.money(c.spentHomeMinor, homeCurrency)}
                </Text>
              </Box>
            ))}
          </RowGroup>
        </Section>
      ) : (
        <Box px={4}>
          <Text variant="caption">{t("lite:home.cardEmpty")}</Text>
        </Box>
      )}
    </>
  );
}

const OUTCOME_TONE: Record<AgentOutcome, StatusTone> = {
  PAID_AUTO: "positive",
  PAID_APPROVED: "positive",
  WAITING: "info",
  HELD: "warning",
  DECLINED: "neutral",
  OTHER: "neutral",
};

/** Under the Kassa card: orders to sign, the latest things Kassa did, and who decides. */
function KassaDetails() {
  const t = useKassaT();
  const f = useFormat();
  const items = useAgentActivity().data?.items ?? [];
  return (
    <>
      <ToSign max={SECTION_ROWS} />
      <Section title={t("lite:home.latest")} onSeeAll={() => router.navigate("/chat" as Href)}>
        <RowGroup>
          {items.length > 0 ? (
            items
              .slice(0, SECTION_ROWS)
              .map((i) => (
                <Row
                  key={i.proposalId}
                  title={`${i.payeeName || t("home:agent.someone")} · ${f.money(i.amountMinor, i.currency)}`}
                  subtitle={t(`home:agent.by.${i.createdBy}`)}
                  trailing={
                    <StatusChip
                      tone={OUTCOME_TONE[i.outcome]}
                      label={t(`home:agent.outcome.${i.outcome}`)}
                    />
                  }
                  chevron
                  onPress={() => router.push(`/order/${i.proposalId}` as Href)}
                />
              ))
          ) : (
            <Box p={4}>
              <Text variant="caption">{t("home:agent.empty")}</Text>
            </Box>
          )}
        </RowGroup>
      </Section>
      <Box px={4}>
        <Text variant="caption">{t("lite:home.kassaFooter")}</Text>
      </Box>
    </>
  );
}

/** Under the Add card page: where cards come from. */
function AddDetails() {
  const t = useKassaT();
  return (
    <>
      <Box px={4}>
        <Text variant="caption">{t("lite:home.addBody")}</Text>
      </Box>
      <RowGroup icons>
        <Row
          leading={<Icon name="plus.circle" fallback="add_circle" size={20} color="foreground" />}
          title={t("lite:home.addCard")}
          onPress={() => router.push("/cards?add=1" as Href)}
        />
        <Row
          leading={
            <Icon name="building.columns" fallback="account_balance" size={20} color="foreground" />
          }
          title={t("lite:home.linkedAccounts")}
          onPress={() => router.push("/linked-accounts")}
        />
        <Row
          leading={<Icon name="doc.text" fallback="description" size={20} color="foreground" />}
          title={t("settings:importScreen.addRow")}
          onPress={() => router.push("/import" as Href)}
        />
      </RowGroup>
    </>
  );
}

/** One pill per deck page; the active one filled. */
function Chip({
  label,
  active,
  onPress,
  onLayout,
  a11y,
}: {
  label: ReactNode;
  active: boolean;
  onPress: () => void;
  onLayout: (x: number) => void;
  a11y: string;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      accessibilityLabel={a11y}
      onPress={onPress}
      onLayout={(e) => onLayout(e.nativeEvent.layout.x)}
      hitSlop={4}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        paddingHorizontal: 14,
        height: 34,
        borderRadius: 17,
        backgroundColor: active ? colors.brandAccent : colors.muted,
      }}
    >
      {typeof label === "string" ? (
        <Text
          weight="semibold"
          numberOfLines={1}
          style={{ fontSize: 14, color: active ? colors.primaryForeground : colors.foreground }}
        >
          {label}
        </Text>
      ) : (
        label
      )}
    </Pressable>
  );
}

function shortLabel(card: CardDto): string {
  const label =
    card.label.length > CHIP_LABEL ? `${card.label.slice(0, CHIP_LABEL - 1)}…` : card.label;
  return cardName({ label, last4: card.last4 });
}

/** Transactions in the shape Home's purchase rows take (merged duplicates left out). */
export function asCaptures(items: readonly TransactionDto[]): RecentCapture[] {
  return items
    .filter((t) => t.mergedIntoId === null)
    .map((t) => ({
      id: t.id,
      source: t.source,
      merchant: t.merchantRaw,
      amountMinor: t.amountMinor,
      currency: t.currency,
      homeAmountMinor: t.homeAmountMinor,
      category: t.category,
      occurredAt: t.occurredAt,
      createdAt: t.occurredAt,
      cardId: t.cardId,
    }));
}

/**
 * KassaLite Home: a swipeable deck (everything, each card, what Kassa did, add a card) with a chip strip, and under it
 * only the few things the active page needs; the details are one tap away (Activity, Insights, Bills). The full app's
 * Pay grid, statements card, budget list and More list are left out on purpose.
 */
export function LiteHomeScreen() {
  const t = useKassaT();
  const window = useWindowDimensions();
  const me = useMe();
  const insights = useSpendingInsights();
  const recent = useRecentCaptures();
  const transactions = useTransactions();
  const cards = useCards();
  const budgets = useBudgets();
  const activity = useAgentActivity();
  const pending = usePendingProposals();
  const obligations = useObligations();
  const mode = useDataMode();

  const [deckWidth, setDeckWidth] = useState(
    Platform.OS === "web" ? Math.min(window.width, WEB_MAX) : window.width
  );
  // A wide window keeps a card's proportions and shows the next ones beside it.
  const cardWidth = Math.min(CARD_MAX, Math.max(200, deckWidth - PEEK));
  const interval = cardWidth + GAP;

  const cardList = useMemo(() => cards.data?.cards ?? [], [cards.data]);
  const pages = useMemo<Page[]>(
    () => [
      { kind: "all" },
      { kind: "wallet" },
      ...cardList.map((card) => ({ kind: "card" as const, card })),
      { kind: "kassa" },
      { kind: "add" },
    ],
    [cardList]
  );
  const [active, setActive] = useState(0);
  const index = Math.min(active, pages.length - 1);
  const page = pages[index]!;

  // KassaLite lists what the Apple Pay Shortcut logged; the full app and the website list every transaction
  // (bank history included), so Home agrees with the month total above it.
  const lite = isLiteBuild();
  const captures = useMemo(
    () =>
      lite
        ? visibleCaptures(recent.data?.captures ?? [], mode)
        : asCaptures(transactions.data?.pages[0]?.items ?? []),
    [lite, recent.data, transactions.data, mode]
  );
  // An older server sends no card on any purchase: card totals are unknown rather than zero.
  const matched = !lite || (recent.data?.captures ?? []).some((c) => "cardId" in c);
  const homeCurrency = insights.data?.homeCurrency ?? me.data?.homeCurrency;

  const deck = useRef<ScrollView>(null);
  const strip = useRef<ScrollView>(null);
  const chipX = useRef<Record<string, number>>({});
  /** Set while a chip tap scrolls the deck: the pages passed on the way do not count as a swipe. */
  const target = useRef<number | null>(null);

  const select = (i: number) => {
    if (i === index) return;
    haptics.selection();
    setActive(i);
  };

  const goTo = (i: number) => {
    target.current = i;
    select(i);
    deck.current?.scrollTo({ x: i * interval, animated: true });
  };

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const i = Math.max(
      0,
      Math.min(pages.length - 1, Math.round(e.nativeEvent.contentOffset.x / interval))
    );
    if (target.current !== null) {
      if (i === target.current) target.current = null;
      return;
    }
    select(i);
  };

  // Keep the active chip in view.
  useEffect(() => {
    const x = chipX.current[pageKey(page)];
    if (x !== undefined) strip.current?.scrollTo({ x: Math.max(0, x - EDGE), animated: true });
  }, [page]);

  const kassaIndex = pages.findIndex((p) => p.kind === "kassa");

  return (
    <>
      <Stack.Screen options={{ headerRight: () => <FreezeButton iconOnly /> }} />
      <ScrollScreen
        testID="home-screen"
        onRefresh={() =>
          Promise.all([
            me.refetch(),
            insights.refetch(),
            recent.refetch(),
            transactions.refetch(),
            cards.refetch(),
            budgets.refetch(),
            activity.refetch(),
            pending.refetch(),
            obligations.refetch(),
          ])
        }
      >
        {me.data?.frozenAt ? (
          <Card>
            <Box row gap={3} align="center">
              <Icon name="snowflake" fallback="ac_unit" size={22} color="destructive" />
              <Box flex={1} gap={1}>
                <Text weight="semibold">{t("home:frozenTitle")}</Text>
                <Text variant="caption">{t("home:frozenBody")}</Text>
              </Box>
            </Box>
          </Card>
        ) : null}

        {/* Bleeds past the screen padding so cards scroll in from the edge. */}
        <View
          style={{ marginHorizontal: -EDGE, gap: 14 }}
          onLayout={(e) => setDeckWidth(e.nativeEvent.layout.width)}
        >
          <ScrollView
            ref={deck}
            horizontal
            showsHorizontalScrollIndicator={false}
            snapToInterval={interval}
            decelerationRate="fast"
            disableIntervalMomentum
            onScroll={onScroll}
            scrollEventThrottle={16}
            contentContainerStyle={{
              paddingLeft: EDGE,
              // The last page can snap to the left edge like the others.
              paddingRight: deckWidth - cardWidth - EDGE,
              gap: GAP,
            }}
            testID="home-deck"
          >
            {pages.map((p) =>
              p.kind === "all" ? (
                <AllCard key="all" width={cardWidth} />
              ) : p.kind === "wallet" ? (
                <WalletCard key="wallet" width={cardWidth} />
              ) : p.kind === "card" ? (
                <CardPage
                  key={p.card.id}
                  card={p.card}
                  width={cardWidth}
                  captures={captures}
                  matched={matched}
                  homeCurrency={homeCurrency}
                />
              ) : p.kind === "kassa" ? (
                <KassaCard key="kassa" width={cardWidth} />
              ) : (
                <AddCardPage key="add" width={cardWidth} />
              )
            )}
          </ScrollView>

          <ScrollView
            ref={strip}
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ paddingHorizontal: EDGE, gap: 8 }}
            accessibilityRole="tablist"
          >
            {pages.map((p, i) => {
              const key = pageKey(p);
              const isActive = i === index;
              const label =
                p.kind === "all" ? (
                  t("lite:home.all")
                ) : p.kind === "wallet" ? (
                  t("lite:home.wallet")
                ) : p.kind === "card" ? (
                  shortLabel(p.card)
                ) : p.kind === "kassa" ? (
                  t("lite:home.kassa")
                ) : (
                  <Icon
                    name="plus"
                    fallback="add"
                    size={16}
                    color={isActive ? "primaryForeground" : "foreground"}
                  />
                );
              return (
                <Chip
                  key={key}
                  label={label}
                  active={isActive}
                  a11y={
                    p.kind === "card"
                      ? cardName(p.card)
                      : p.kind === "add"
                        ? t("lite:home.addCard")
                        : (label as string)
                  }
                  onPress={() => goTo(i)}
                  onLayout={(x) => {
                    chipX.current[key] = x;
                  }}
                />
              );
            })}
          </ScrollView>
        </View>

        {/* Quick pay: the same five recipient groups as the full Home. */}
        <PayTo />

        {page.kind === "all" ? (
          <AllDetails captures={captures} onMore={() => goTo(kassaIndex)} />
        ) : page.kind === "wallet" ? (
          <WalletDetails />
        ) : page.kind === "card" ? (
          matched ? (
            <CardDetails card={page.card} captures={captures} homeCurrency={homeCurrency} />
          ) : (
            <Box px={4}>
              <Text variant="caption">{t("lite:home.cardEmpty")}</Text>
            </Box>
          )
        ) : page.kind === "kassa" ? (
          <KassaDetails />
        ) : (
          <AddDetails />
        )}
      </ScrollScreen>
    </>
  );
}
