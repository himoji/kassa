/**
 * Native share sheet on React Native's `Share`.
 *
 * iOS takes `url` as a separate field; Android only reads `message`, so the url
 * is appended there. Resolves `true` when the user completed a share (on
 * Android the sheet cannot tell, so `true` means it was shown).
 */
import { Platform, Share, type ShareContent } from "react-native";

import { crash } from "@/lib/crash";

export interface ShareTextOptions {
  message: string;
  url?: string;
  title?: string;
}

function toContent({ message, url, title }: ShareTextOptions): ShareContent {
  if (Platform.OS === "ios") {
    return url ? { message: message || undefined, url, title } : { message, title };
  }
  const joined = url ? (message ? `${message}\n${url}` : url) : message;
  return { message: joined, title };
}

export async function shareText(opts: ShareTextOptions): Promise<boolean> {
  try {
    const result = await Share.share(toContent(opts), {
      dialogTitle: opts.title,
      subject: opts.title,
    });
    return result.action === Share.sharedAction;
  } catch (err) {
    crash.capture(err, { where: "share.shareText" });
    return false;
  }
}

export function shareUrl(url: string, title?: string): Promise<boolean> {
  return shareText({ message: "", url, title });
}
