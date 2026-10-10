/**
 * TanStack Query (data/react-query module), provider order 20.
 *
 * Native-friendly defaults: refetch on app foreground via `AppState`
 * (`focusManager`), one retry, 30s stale / 5min gc. `onlineManager` keeps the
 * library default (always online) because no NetInfo dependency is bundled.
 */
import { focusManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, type ReactNode } from "react";
import { AppState, type AppStateStatus } from "react-native";

import { onWipeLocalData } from "@/lib/privacy";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30_000,
      gcTime: 5 * 60_000,
    },
  },
});

// Sign-out / account deletion (`wipeLocalData`): the next user never sees this user's responses.
onWipeLocalData(() => queryClient.clear());

function useAppStateFocus(): void {
  useEffect(() => {
    const onChange = (status: AppStateStatus): void => {
      focusManager.setFocused(status === "active");
    };
    const subscription = AppState.addEventListener("change", onChange);
    return () => {
      subscription.remove();
    };
  }, []);
}

export function QueryProvider({ children }: { children?: ReactNode }) {
  useAppStateFocus();
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
