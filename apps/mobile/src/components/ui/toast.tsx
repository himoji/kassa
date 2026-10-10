import { useCallback, useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import Animated, { FadeInUp, FadeOutUp } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { radius, space } from "@/theme/tokens";
import { showNativeToast } from "@/lib/native-toast";
import type { ToastApi, ToastKind, ToastOptions } from "@/components/ui/types";

import { Text } from "./text";
import { useTheme } from "./theme-provider";

// ---------------------------------------------------------------------------
// Module-level emitter: `toast.show()` works from anywhere (stores, handlers),
// `ToastHost` (provider order 90) is the single subscriber that renders.
// ---------------------------------------------------------------------------

interface ToastItem extends ToastOptions {
  id: number;
}

type Listener = (item: ToastItem) => void;

const listeners = new Set<Listener>();
let nextId = 1;

export const toast: ToastApi = {
  show(opts) {
    // A native toast (Burnt, iOS dev/store builds) when the build has one; else the card below.
    if (showNativeToast(opts)) return;
    const item: ToastItem = { ...opts, id: nextId++ };
    listeners.forEach((listener) => listener(item));
  },
};

/**
 * Auto-dismiss after this many ms unless `duration` is given. A `duration <= 0`
 * makes the toast sticky: it stays until tapped (adapter behaviour; the
 * contract only says "adapters default to ~3000").
 */
const DEFAULT_DURATION = 3000;

function useKindColor(kind: ToastKind): string {
  const { colors } = useTheme();
  if (kind === "success") return colors.success;
  if (kind === "error") return colors.destructive;
  return colors.primary;
}

function ToastCard({ item, dismiss }: { item: ToastItem; dismiss: (id: number) => void }) {
  const { colors } = useTheme();
  const accent = useKindColor(item.kind ?? "info");

  // `dismiss` is stable (useCallback in ToastHost), so the timer only restarts
  // when this toast's own id/duration change - not when siblings come and go.
  useEffect(() => {
    const duration = item.duration ?? DEFAULT_DURATION;
    if (duration <= 0) return;
    const timer = setTimeout(() => dismiss(item.id), duration);
    return () => clearTimeout(timer);
  }, [item.id, item.duration, dismiss]);

  return (
    <Animated.View entering={FadeInUp} exiting={FadeOutUp}>
      <Pressable
        onPress={() => dismiss(item.id)}
        role="alert"
        style={{
          backgroundColor: colors.card,
          borderColor: colors.border,
          borderLeftColor: accent,
          borderWidth: 1,
          borderLeftWidth: 4,
          borderRadius: radius.lg,
          padding: space[3],
          gap: space[1],
        }}
      >
        <Text variant="label" color="cardForeground">
          {item.title}
        </Text>
        {item.description ? <Text variant="caption">{item.description}</Text> : null}
      </Pressable>
    </Animated.View>
  );
}

export function ToastHost() {
  const [items, setItems] = useState<ToastItem[]>([]);
  const insets = useSafeAreaInsets();

  const dismiss = useCallback((id: number) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
  }, []);

  useEffect(() => {
    const listener: Listener = (item) => setItems((prev) => [...prev, item]);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  if (items.length === 0) return null;

  return (
    <View
      pointerEvents="box-none"
      style={{
        position: "absolute",
        top: insets.top + space[2],
        left: space[4],
        right: space[4],
        gap: space[2],
      }}
    >
      {items.map((item) => (
        <ToastCard key={item.id} item={item} dismiss={dismiss} />
      ))}
    </View>
  );
}
