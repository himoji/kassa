import { createContext, useContext, type Context } from "react";
import { FlatList, ScrollView, View, type ListRenderItemInfo } from "react-native";

import { isIOS } from "@/lib/utils";
import { radius as radii, space } from "@/theme/tokens";
import type { ListProps } from "@/components/ui/types";

import { Divider } from "./divider";
import { useTheme } from "./theme-provider";

/** 16pt row padding + 28pt leading slot + 12pt gap - lines the rule up with the title. */
const SEPARATOR_INSET = 56;

/**
 * RN's ScrollView context is internal (absent from the TS types) but it is the
 * exact signal `VirtualizedList` uses to log "VirtualizedLists should never be
 * nested inside plain ScrollViews". When a List *is* nested - the dev catalog,
 * a handful of static rows - we hand scrolling to the parent instead of erroring.
 * Virtualisation is lost that way, which is why list screens use a non-scroll
 * `<Screen>`. The fallback keeps this working if RN ever drops the context.
 */
const ScrollViewContext =
  (ScrollView as unknown as { Context?: Context<unknown> }).Context ?? createContext<unknown>(null);

function defaultKey(item: unknown, index: number): string {
  if (typeof item === "object" && item !== null && "id" in item) {
    const { id } = item as { id: unknown };
    if (typeof id === "string" || typeof id === "number") return String(id);
  }
  return String(index);
}

/**
 * Virtualised list (RN `FlatList`). Pair with a non-scroll `<Screen>`; see
 * `ListProps` in the contract.
 */
export function List<T>({
  data,
  renderItem,
  keyExtractor,
  separator = true,
  header,
  footer,
  empty,
  refreshing,
  onRefresh,
  contentContainerStyle,
  style,
  testID,
  inset = false,
}: ListProps<T>) {
  const { colors } = useTheme();
  const nested = useContext(ScrollViewContext) !== null;

  const renderSeparator =
    separator === false
      ? undefined
      : separator === true
        ? () => (
            <View style={{ paddingLeft: SEPARATOR_INSET }}>
              <Divider spacing={0} />
            </View>
          )
        : () => <>{separator}</>;

  return (
    <FlatList
      testID={testID}
      data={data as T[]}
      renderItem={({ item, index }: ListRenderItemInfo<T>) => <>{renderItem(item, index)}</>}
      keyExtractor={keyExtractor ?? defaultKey}
      ItemSeparatorComponent={renderSeparator}
      ListHeaderComponent={header != null ? <>{header}</> : null}
      ListFooterComponent={footer != null ? <>{footer}</> : null}
      ListEmptyComponent={empty != null ? <>{empty}</> : null}
      refreshing={onRefresh ? (refreshing ?? false) : undefined}
      onRefresh={onRefresh}
      scrollEnabled={!nested}
      contentInsetAdjustmentBehavior={isIOS ? "automatic" : undefined}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={[
        inset
          ? {
              backgroundColor: colors.card,
              borderColor: colors.border,
              borderWidth: 1,
              borderRadius: radii.lg,
              overflow: "hidden",
              marginHorizontal: space[4],
            }
          : null,
        contentContainerStyle,
      ]}
      style={style}
    />
  );
}
