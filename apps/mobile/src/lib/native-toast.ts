/**
 * Native toasts through Burnt (https://github.com/nandorojo/burnt): on iOS, `toast.show()`
 * from `@/components/ui` becomes the system-style SPIndicator pill - with haptics, above native modals
 * and sheets - instead of a React-drawn card.
 *
 * Burnt is a native module, so it exists in dev and store builds only. In Expo Go, on Android
 * (where the platform toast has no title/description) and on web, `showNativeToast` returns
 * `false` and the UI kit's own themed toast renders instead - screens never need to know.
 */
import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";

import type { ToastOptions } from "@/components/ui/types";

/** `true` when this build carries Burnt's native module (a dev or store build on iOS). */
export const nativeToastAvailable =
  Platform.OS === "ios" && requireOptionalNativeModule("Burnt") !== null;

type BurntPreset = "done" | "error" | "none";

const PRESET: Record<NonNullable<ToastOptions["kind"]>, BurntPreset> = {
  success: "done",
  error: "error",
  info: "none",
};

/** Shows `opts` as a native toast; `false` when this build has none (use the JS toast). */
export function showNativeToast(opts: ToastOptions): boolean {
  if (!nativeToastAvailable) return false;
  const kind = opts.kind ?? "info";
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- loaded lazily: native-only
    const Burnt = require("burnt") as typeof import("burnt");
    void Burnt.toast({
      title: opts.title,
      message: opts.description,
      preset: PRESET[kind],
      haptic: kind === "error" ? "error" : kind === "success" ? "success" : "none",
      // Burnt takes seconds; the contract takes milliseconds (default ~3000).
      duration: Math.max(1, (opts.duration ?? 3000) / 1000),
      from: "top",
    });
    return true;
  } catch (err) {
    console.warn("[toast] native toast failed, falling back", err);
    return false;
  }
}
