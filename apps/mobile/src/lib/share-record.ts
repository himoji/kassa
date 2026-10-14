/**
 * Sharing a credit record: the verify link, or the PDF itself.
 *
 * Why the old button failed: it called React Native's `Share.share`, which on the web build is `navigator.share`.
 * Desktop Firefox, most desktop Chrome builds on Linux/Windows and any page outside a secure context have no
 * `navigator.share`, so react-native-web rejects with "Share is not supported in this browser" and the app showed
 * that as an error. Here the share sheet is used where it exists, a dismissed sheet is not an error, and everywhere
 * else the link is copied to the clipboard (the PDF is downloaded) instead.
 */
import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { Platform, Share } from "react-native";

import { copyToClipboard } from "@/lib/clipboard";
import { crash } from "@/lib/crash";

export type ShareOutcome = "shared" | "copied" | "downloaded" | "cancelled" | "failed";

interface WebShareNavigator {
  share?: (data: {
    title?: string;
    text?: string;
    url?: string;
    files?: unknown[];
  }) => Promise<void>;
  canShare?: (data: { files?: unknown[] }) => boolean;
}

function webNavigator(): WebShareNavigator | null {
  return typeof navigator === "undefined" ? null : (navigator as unknown as WebShareNavigator);
}

/** The user closed the sheet: not a failure. */
function isAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || /cancel|dismiss/i.test(err.message));
}

/** Share sheet with the link; without one (or if it refuses), the link goes to the clipboard. */
export async function shareLink(opts: {
  url: string;
  title: string;
  message: string;
  copiedToast: string;
}): Promise<ShareOutcome> {
  try {
    if (Platform.OS === "web") {
      const nav = webNavigator();
      if (nav?.share) {
        await nav.share({ title: opts.title, text: opts.message, url: opts.url });
        return "shared";
      }
    } else {
      const res = await Share.share(
        Platform.OS === "ios"
          ? { message: opts.message, url: opts.url, title: opts.title }
          : { message: `${opts.message}\n${opts.url}`, title: opts.title },
        { dialogTitle: opts.title, subject: opts.title }
      );
      return res.action === Share.dismissedAction ? "cancelled" : "shared";
    }
  } catch (err) {
    if (isAbort(err)) return "cancelled";
    crash.capture(err, { where: "shareRecord.link" });
  }
  return (await copyToClipboard(opts.url, { toast: opts.copiedToast })) ? "copied" : "failed";
}

/** The PDF as a file: the native share sheet, the web share sheet with a file, else a download. */
export async function sharePdf(opts: {
  url: string;
  fileName: string;
  title: string;
}): Promise<ShareOutcome> {
  try {
    if (Platform.OS !== "web") {
      if (!(await Sharing.isAvailableAsync())) return "failed";
      const target = new File(Paths.cache, opts.fileName);
      if (target.exists) target.delete();
      const file = await File.downloadFileAsync(opts.url, target);
      await Sharing.shareAsync(file.uri, {
        mimeType: "application/pdf",
        UTI: "com.adobe.pdf",
        dialogTitle: opts.title,
      });
      return "shared";
    }
    const res = await fetch(opts.url);
    if (!res.ok) throw new Error(`PDF download failed: HTTP ${res.status}`);
    const blob = await res.blob();
    const nav = webNavigator();
    if (typeof globalThis.File === "function") {
      const pdf = new globalThis.File([blob], opts.fileName, { type: "application/pdf" });
      if (nav?.share && nav.canShare?.({ files: [pdf] })) {
        await nav.share({ files: [pdf], title: opts.title });
        return "shared";
      }
    }
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = opts.fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 10_000);
    return "downloaded";
  } catch (err) {
    if (isAbort(err)) return "cancelled";
    crash.capture(err, { where: "shareRecord.pdf" });
    return "failed";
  }
}
