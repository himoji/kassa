/**
 * Open links without crashing on a bad URL or a missing handler.
 *
 * `openUrl` shows http(s) links in the in-app browser (SFSafariViewController /
 * Custom Tabs) and hands everything else (`mailto:`, `tel:`, custom schemes) to
 * the OS. `openExternal` always leaves the app. Both swallow errors into crash
 * reporting.
 */
import * as WebBrowser from "expo-web-browser";
import { Linking } from "react-native";

import { crash } from "@/lib/crash";

function isWebUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

export async function openExternal(url: string): Promise<void> {
  try {
    await Linking.openURL(url);
  } catch (err) {
    crash.capture(err, { where: "browser.openExternal", url });
  }
}

export async function openUrl(url: string): Promise<void> {
  if (!isWebUrl(url)) {
    await openExternal(url);
    return;
  }
  try {
    await WebBrowser.openBrowserAsync(url);
  } catch (err) {
    // e.g. no Custom Tabs provider on Android: fall back to the system handler.
    crash.capture(err, { where: "browser.openUrl", url });
    await openExternal(url);
  }
}
