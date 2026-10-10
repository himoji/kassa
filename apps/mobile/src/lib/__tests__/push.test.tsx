import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { render } from "@testing-library/react-native";
import { Platform, Text } from "react-native";

import { PushProvider, push } from "../push";

type Listener = (event: unknown) => void;

jest.mock("expo-notifications", () => {
  const listeners: { received: Listener[]; response: Listener[] } = { received: [], response: [] };
  const removed = jest.fn();
  return {
    __listeners: listeners,
    __removed: removed,
    AndroidImportance: { DEFAULT: 3 },
    SchedulableTriggerInputTypes: { TIME_INTERVAL: "timeInterval" },
    scheduleNotificationAsync: jest.fn(() => Promise.resolve("id")),
    setNotificationHandler: jest.fn(),
    setNotificationChannelAsync: jest.fn(() => Promise.resolve()),
    addNotificationReceivedListener: jest.fn((l: Listener) => {
      listeners.received.push(l);
      return { remove: removed };
    }),
    addNotificationResponseReceivedListener: jest.fn((l: Listener) => {
      listeners.response.push(l);
      return { remove: removed };
    }),
    getLastNotificationResponseAsync: jest.fn(() => Promise.resolve(null)),
    getPermissionsAsync: jest.fn(() => Promise.resolve({ granted: false })),
    requestPermissionsAsync: jest.fn(() => Promise.resolve({ granted: false })),
    getExpoPushTokenAsync: jest.fn(() => Promise.reject(new Error("unused"))),
  };
});
jest.mock("expo-device", () => ({ isDevice: true }));
jest.mock("expo-constants", () => ({
  __esModule: true,
  default: { expoConfig: { extra: { eas: { projectId: "proj" } } } },
}));
jest.mock("expo-router", () => ({ router: { push: jest.fn() } }));

const notifications = jest.requireMock("expo-notifications") as {
  __listeners: { received: Listener[]; response: Listener[] };
  __removed: jest.Mock;
  setNotificationHandler: jest.Mock;
  setNotificationChannelAsync: jest.Mock;
  getLastNotificationResponseAsync: jest.Mock<() => Promise<unknown>>;
  getPermissionsAsync: jest.Mock<() => Promise<{ granted: boolean }>>;
  requestPermissionsAsync: jest.Mock<() => Promise<{ granted: boolean }>>;
  scheduleNotificationAsync: jest.Mock;
};
const routerPush = (jest.requireMock("expo-router") as { router: { push: jest.Mock } }).router.push;

function response(data: Record<string, unknown>, id = "n1") {
  return {
    actionIdentifier: "expo.modules.notifications.actions.DEFAULT",
    notification: {
      date: 0,
      request: { identifier: id, content: { data, title: "t" }, trigger: null },
    },
  };
}

describe("PushProvider (expo-notifications)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    notifications.__listeners.received = [];
    notifications.__listeners.response = [];
  });

  it("exports the shim surface", () => {
    expect(typeof push.usePushToken).toBe("function");
    expect(typeof push.requestPermission).toBe("function");
    expect(typeof push.sendTestNotification).toBe("function");
  });

  it("sendTestNotification schedules a local notification when permission is granted", async () => {
    notifications.getPermissionsAsync.mockResolvedValueOnce({ granted: true });
    const content = { title: "Test", body: "Hello" };
    await expect(push.sendTestNotification!(content)).resolves.toBe(true);
    expect(notifications.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(notifications.scheduleNotificationAsync).toHaveBeenCalledWith({
      content,
      trigger: { type: "timeInterval", seconds: 3 },
    });
  });

  it("sendTestNotification asks first and schedules nothing when refused", async () => {
    const content = { title: "Test", body: "Hello" };
    await expect(push.sendTestNotification!(content, 5)).resolves.toBe(false);
    expect(notifications.requestPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
  });

  it("sets the handler, registers listeners, and routes tapped notifications with data.url", async () => {
    const screen = await render(
      <PushProvider>
        <Text>child</Text>
      </PushProvider>
    );
    expect(screen.getByText("child")).toBeTruthy();
    expect(notifications.setNotificationHandler).toHaveBeenCalledTimes(1);
    expect(notifications.__listeners.received).toHaveLength(1);
    expect(notifications.__listeners.response).toHaveLength(1);

    notifications.__listeners.response[0](response({ url: "/examples/push" }));
    expect(routerPush).toHaveBeenCalledWith("/examples/push");

    routerPush.mockClear();
    notifications.__listeners.response[0](response({}, "n2"));
    expect(routerPush).not.toHaveBeenCalled();

    await screen.unmount();
    expect(notifications.__removed).toHaveBeenCalledTimes(2);
  });

  it("creates the Android `default` channel on mount", async () => {
    const os = Object.getOwnPropertyDescriptor(Platform, "OS")!;
    Object.defineProperty(Platform, "OS", { value: "android", configurable: true });
    try {
      await render(<PushProvider>{null}</PushProvider>);
      expect(notifications.setNotificationChannelAsync).toHaveBeenCalledWith(
        "default",
        expect.objectContaining({ name: "Default" })
      );
    } finally {
      Object.defineProperty(Platform, "OS", os);
    }
  });

  it("routes the notification that cold-started the app exactly once", async () => {
    notifications.getLastNotificationResponseAsync.mockResolvedValueOnce(
      response({ url: "/settings" }, "cold")
    );
    await render(<PushProvider>{null}</PushProvider>);

    await new Promise((r) => setTimeout(r, 0));
    expect(routerPush).toHaveBeenCalledWith("/settings");
    // The same response replayed through the listener (some platforms do) is ignored.
    notifications.__listeners.response[0](response({ url: "/settings" }, "cold"));
    expect(routerPush).toHaveBeenCalledTimes(1);
  });
});
