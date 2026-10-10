import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { act, renderHook, waitFor } from "@testing-library/react-native";

import { storage } from "@/lib/storage";

import * as mod from "../use-push-token";

jest.mock("expo-notifications", () => ({
  __esModule: true,
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  getExpoPushTokenAsync: jest.fn(),
}));
// `__esModule` so the hook's namespace import shares this object (no interop copy) and
// tests can flip `isDevice`.
jest.mock("expo-device", () => ({ __esModule: true, isDevice: true }));
jest.mock("expo-constants", () => ({
  __esModule: true,
  default: { expoConfig: { extra: { eas: { projectId: "proj-123" } } } },
}));

const notifications = jest.requireMock("expo-notifications") as {
  getPermissionsAsync: jest.Mock<() => Promise<{ granted: boolean }>>;
  requestPermissionsAsync: jest.Mock<() => Promise<{ granted: boolean }>>;
  getExpoPushTokenAsync: jest.Mock<() => Promise<{ type: "expo"; data: string }>>;
};
const device = jest.requireMock("expo-device") as { isDevice: boolean };
const constants = (
  jest.requireMock("expo-constants") as {
    default: { expoConfig: { extra: { eas: { projectId: string } } } };
  }
).default;

const TOKEN = "ExponentPushToken[abc]";

describe("usePushToken (expo-notifications)", () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    jest.spyOn(console, "warn").mockImplementation(() => {});
    device.isDevice = true;
    constants.expoConfig.extra.eas.projectId = "proj-123";
    notifications.getPermissionsAsync.mockResolvedValue({ granted: true });
    notifications.requestPermissionsAsync.mockResolvedValue({ granted: true });
    notifications.getExpoPushTokenAsync.mockResolvedValue({ type: "expo", data: TOKEN });
    await storage.removeItem("readynative:push-token");
    mod.__resetPushTokenForTests();
  });

  it("starts loading, then registers a token when permission is granted", async () => {
    const { result } = await renderHook(() => mod.usePushToken());

    await waitFor(() => expect(result.current.status).toBe("granted"));
    expect(result.current.token).toBe(TOKEN);
    expect(notifications.getExpoPushTokenAsync).toHaveBeenCalledWith({ projectId: "proj-123" });
    await expect(storage.getItem("readynative:push-token")).resolves.toBe(TOKEN);
  });

  it("is denied (without prompting) when permission is not granted yet", async () => {
    notifications.getPermissionsAsync.mockResolvedValue({ granted: false });
    const { result } = await renderHook(() => mod.usePushToken());

    await waitFor(() => expect(result.current.status).toBe("denied"));
    expect(notifications.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(notifications.getExpoPushTokenAsync).not.toHaveBeenCalled();
  });

  it("requestPermission prompts and moves every subscriber to granted", async () => {
    notifications.getPermissionsAsync.mockResolvedValue({ granted: false });
    const { result } = await renderHook(() => mod.usePushToken());
    await waitFor(() => expect(result.current.status).toBe("denied"));

    let granted = false;
    await act(async () => {
      granted = await mod.requestPushPermission();
    });

    expect(granted).toBe(true);
    expect(result.current).toEqual({ token: TOKEN, status: "granted" });
  });

  it("requestPermission resolves false and stays denied when the user refuses", async () => {
    notifications.getPermissionsAsync.mockResolvedValue({ granted: false });
    notifications.requestPermissionsAsync.mockResolvedValue({ granted: false });
    const { result } = await renderHook(() => mod.usePushToken());

    let granted = true;
    await act(async () => {
      granted = await mod.requestPushPermission();
    });

    expect(granted).toBe(false);
    expect(result.current).toEqual({ token: null, status: "denied" });
  });

  it("is unsupported on a simulator, but permission can still be granted for local notifications", async () => {
    device.isDevice = false;
    const { result } = await renderHook(() => mod.usePushToken());

    await waitFor(() => expect(result.current.status).toBe("unsupported"));
    expect(notifications.getPermissionsAsync).not.toHaveBeenCalled();

    await expect(mod.requestPushPermission()).resolves.toBe(true);
    expect(notifications.requestPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(notifications.getExpoPushTokenAsync).not.toHaveBeenCalled();
    expect(result.current).toEqual({ token: null, status: "unsupported" });

    notifications.requestPermissionsAsync.mockResolvedValue({ granted: false });
    await expect(mod.requestPushPermission()).resolves.toBe(false);
    expect(result.current).toEqual({ token: null, status: "denied" });
  });

  it("is unsupported (with an `eas init` hint) when the EAS project id is empty", async () => {
    constants.expoConfig.extra.eas.projectId = "";
    const { result } = await renderHook(() => mod.usePushToken());

    await waitFor(() => expect(result.current.status).toBe("unsupported"));
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("eas init"));
  });

  it("falls back to the cached token when the push service is unreachable", async () => {
    await storage.setItem("readynative:push-token", TOKEN);
    notifications.getExpoPushTokenAsync.mockRejectedValue(new Error("offline"));
    const { result } = await renderHook(() => mod.usePushToken());

    await waitFor(() => expect(result.current.status).toBe("granted"));
    expect(result.current.token).toBe(TOKEN);
  });
});
