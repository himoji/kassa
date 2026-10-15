import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import * as SecureStore from "expo-secure-store";

import { clearIntentConfig, INTENT_CONFIG_KEY, syncIntentConfig } from "../intent-config";

let mockServer: string | null = "https://kassa.example.com";
let mockToken: string | null = "ksc_test";
jest.mock("../server-url", () => ({ loadServerUrl: async () => mockServer }));
jest.mock("../shortcut-token", () => ({ loadShortcutToken: async () => mockToken }));
jest.mock("react-native", () => ({ Platform: { OS: "ios" } }));

describe("intent config (the Log Payment action's Keychain copy)", () => {
  beforeEach(async () => {
    mockServer = "https://kassa.example.com";
    mockToken = "ksc_test";
    await clearIntentConfig();
  });

  it("writes the server and token as the JSON the Swift intent decodes", async () => {
    await syncIntentConfig();
    const raw = await SecureStore.getItemAsync(INTENT_CONFIG_KEY);
    expect(JSON.parse(raw!)).toEqual({ serverUrl: "https://kassa.example.com", token: "ksc_test" });
  });

  it("keeps a working copy when the token cannot be read right now", async () => {
    await syncIntentConfig();
    mockToken = null;
    await syncIntentConfig();
    expect(await SecureStore.getItemAsync(INTENT_CONFIG_KEY)).not.toBeNull();
    await clearIntentConfig();
    expect(await SecureStore.getItemAsync(INTENT_CONFIG_KEY)).toBeNull();
  });
});
