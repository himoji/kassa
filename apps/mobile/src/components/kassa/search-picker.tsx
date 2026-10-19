/**
 * A picker for long lists (currencies, countries, categories): the row shows the current choice; tapping it opens a
 * search field and the best matches right below, inline, so it also works inside sheets and forms. Matches on the
 * label and the value: an exact or prefix match ranks first, then a word that starts with the query, then any substring.
 * Every match is listed in a scroll box of its own (nested inside the screen's ScrollView), so the whole list can be
 * browsed without typing, and a tap picks a row while the keyboard is still up.
 */
import { useMemo, useState } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";

import { Icon, Text, useTheme } from "@/components/ui";
import { useKassaT } from "@/lib/i18n";

import type { PickerOption } from "./native-controls";

/** Lists longer than this get the search picker instead of a menu. */
export const SEARCH_PICKER_THRESHOLD = 12;

const MAX_RESULTS = 8;

/** Height of the results box: about seven rows, then it scrolls. */
const RESULTS_MAX_HEIGHT = 288;

export function searchOptions<T extends string>(
  options: readonly PickerOption<T>[],
  query: string,
  limit = MAX_RESULTS
): PickerOption<T>[] {
  const q = query.trim().toLowerCase();
  if (!q) return options.slice(0, limit);
  const scored = options
    .map((o, index) => {
      const value = o.value.toLowerCase();
      const label = o.label.toLowerCase();
      let score = 9;
      if (value === q || label === q) score = 0;
      else if (value.startsWith(q)) score = 1;
      else if (label.startsWith(q)) score = 2;
      else if (label.split(/[\s·,()/-]+/).some((w) => w.startsWith(q))) score = 3;
      else if (label.includes(q) || value.includes(q)) score = 4;
      return { o, score, index };
    })
    .filter((s) => s.score < 9);
  return scored
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .slice(0, limit)
    .map((s) => s.o);
}

interface SearchPickerProps<T extends string> {
  label: string;
  value: T | null;
  options: readonly PickerOption<T>[];
  onChange: (value: T) => void;
  /** Turns a query nothing matches into a choice of its own (e.g. a new budget category). */
  custom?: (query: string) => PickerOption<T> | null;
  disabled?: boolean;
  testID?: string;
}

export function SearchPicker<T extends string>({
  label,
  value,
  options,
  onChange,
  custom,
  disabled,
  testID,
}: SearchPickerProps<T>) {
  const t = useKassaT();
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const matches = useMemo(() => searchOptions(options, query, options.length), [options, query]);
  const extra = custom && query.trim() && matches.length === 0 ? custom(query) : null;
  const current = options.find((o) => o.value === value);

  const pick = (v: T) => {
    onChange(v);
    setOpen(false);
    setQuery("");
  };

  return (
    <View testID={testID}>
      <Pressable
        onPress={() => setOpen((o) => !o)}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ expanded: open, disabled: !!disabled }}
        style={{
          minHeight: 44,
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: 16,
          gap: 12,
          opacity: disabled ? 0.5 : 1,
        }}
      >
        <Text style={{ flex: 1 }}>{label}</Text>
        <Text variant="caption" numberOfLines={1} style={{ flexShrink: 1, textAlign: "right" }}>
          {current?.label ?? value ?? t("common:choose")}
        </Text>
        <Icon
          name={open ? "chevron.up" : "chevron.down"}
          fallback={open ? "expand_less" : "expand_more"}
          size={16}
          color="mutedForeground"
        />
      </Pressable>
      {open ? (
        <View style={{ paddingHorizontal: 16, paddingBottom: 12, gap: 4 }}>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              paddingHorizontal: 12,
              borderRadius: 12,
              backgroundColor: colors.muted,
            }}
          >
            <Icon name="magnifyingglass" fallback="search" size={16} color="mutedForeground" />
            <TextInput
              autoFocus
              value={query}
              onChangeText={setQuery}
              placeholder={t("common:search")}
              placeholderTextColor={colors.mutedForeground}
              accessibilityLabel={t("common:searchIn", { label })}
              autoCorrect={false}
              onSubmitEditing={() => {
                const first = matches[0] ?? extra;
                if (first) pick(first.value);
              }}
              style={{ flex: 1, minHeight: 40, color: colors.foreground, fontSize: 16 }}
              testID={testID ? `${testID}-search` : undefined}
            />
          </View>
          <ScrollView
            style={{ maxHeight: RESULTS_MAX_HEIGHT }}
            nestedScrollEnabled
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="none"
            showsVerticalScrollIndicator
            testID={testID ? `${testID}-results` : undefined}
          >
            {[...matches, ...(extra ? [extra] : [])].map((o) => (
              <Pressable
                key={o.value}
                onPress={() => pick(o.value)}
                accessibilityRole="button"
                accessibilityState={{ selected: o.value === value }}
                style={({ pressed }) => ({
                  minHeight: 40,
                  flexDirection: "row",
                  alignItems: "center",
                  paddingHorizontal: 8,
                  borderRadius: 8,
                  backgroundColor: pressed ? colors.muted : "transparent",
                })}
              >
                <Text style={{ flex: 1 }} weight={o.value === value ? "semibold" : "normal"}>
                  {o.label}
                </Text>
                {o.value === value ? (
                  <Icon name="checkmark" fallback="check" size={16} color="brandAccent" />
                ) : null}
              </Pressable>
            ))}
          </ScrollView>
          {matches.length === 0 && !extra ? (
            <Text variant="caption" style={{ paddingHorizontal: 8, paddingVertical: 6 }}>
              {t("common:noMatches")}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
