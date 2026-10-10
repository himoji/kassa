import { Platform } from "react-native";

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const isWeb = Platform.OS === "web";
export const isIOS = Platform.OS === "ios";
export const isAndroid = Platform.OS === "android";
