import { useSyncExternalStore } from "react";

const noSubscribe = () => () => {};

/**
 * False while React hydrates the static web export (and on the server), true on every client render after. Web
 * hydration keeps the server's inline styles, so a value that differs on the client (window width, dark mode) must
 * wait for this before it changes a style.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    noSubscribe,
    () => true,
    () => false
  );
}
