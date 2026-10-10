/**
 * Clipboard helpers on `expo-clipboard` with a "Copied" toast by default.
 */
import * as Clipboard from "expo-clipboard";

import { crash } from "@/lib/crash";
import { toast } from "@/components/ui";

export interface CopyOptions {
  /** Toast title; `false` to stay silent. Default "Copied". */
  toast?: string | false;
}

/** Resolves `true` when the text landed on the clipboard. */
export async function copyToClipboard(text: string, opts?: CopyOptions): Promise<boolean> {
  try {
    await Clipboard.setStringAsync(text);
  } catch (err) {
    crash.capture(err, { where: "clipboard.copy" });
    return false;
  }
  if (opts?.toast !== false) toast.show({ title: opts?.toast ?? "Copied" });
  return true;
}

/** Current clipboard text; `""` when empty or unreadable. */
export async function readClipboard(): Promise<string> {
  try {
    return await Clipboard.getStringAsync();
  } catch (err) {
    crash.capture(err, { where: "clipboard.read" });
    return "";
  }
}
