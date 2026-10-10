import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { router } from "expo-router";
import { Component, type ReactNode } from "react";

import { onboardingEnabled } from "@/hooks/use-onboarding-redirect";
import { auth } from "@/lib/auth";
import { consent, consentEnabled } from "@/lib/consent";
import { envPresence } from "@/lib/env";
import { payments } from "@/lib/payments";
import { privacyCategories } from "@/lib/privacy-categories";
import { push } from "@/lib/push";
import { DeveloperTools } from "@/screens/settings/developer-tools";
import { onboardingStore } from "@/stores/onboarding";
import { Text, ThemeProvider, toast } from "@/components/ui";

/**
 * This file ships with every module selection. Rows for a module exist only when its
 * contract method / flag does, so each check reads the same flag the component does, and
 * the optional contract methods are stubbed to test the row without the module.
 */
type Optional = {
  presentPaywall?: () => Promise<void>;
  openSignIn?: () => void;
  sendTestNotification?: (
    content: { title: string; body: string },
    seconds?: number
  ) => Promise<boolean>;
};

const restores: (() => void)[] = [];

/** Sets `obj[key]` for one test, restored in `afterEach`. */
function stub<T extends object, K extends keyof T>(obj: T, key: K, value: T[K]): void {
  const had = Object.prototype.hasOwnProperty.call(obj, key);
  const original = obj[key];
  obj[key] = value;
  restores.push(() => {
    if (had) obj[key] = original;
    else delete obj[key];
  });
}

class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    return this.state.error ? <Text>caught: {this.state.error.message}</Text> : this.props.children;
  }
}

async function mount() {
  await render(
    <ThemeProvider>
      <Boundary>
        <DeveloperTools />
      </Boundary>
    </ThemeProvider>
  );
}

describe("DeveloperTools", () => {
  afterEach(() => {
    while (restores.length) restores.pop()!();
    jest.restoreAllMocks();
  });

  it("Page map opens Expo Router's sitemap", async () => {
    const pushRoute = jest.spyOn(router, "push").mockImplementation(() => {});
    await mount();
    await act(async () => {
      fireEvent.press(screen.getByText("Page map"));
    });
    expect(pushRoute).toHaveBeenCalledWith("/_sitemap");
  });

  it("shows module rows only for the modules this build has", async () => {
    await mount();
    const shown = (title: string) => screen.queryByText(title) !== null;
    expect(shown("Replay onboarding")).toBe(onboardingEnabled);
    expect(shown("Show consent sheet")).toBe(consentEnabled && privacyCategories.length > 0);
    expect(shown("Preview paywall")).toBe(payments.presentPaywall !== undefined);
    expect(shown("Open sign-in")).toBe((auth as Optional).openSignIn !== undefined);
    expect(shown("Send test notification")).toBe(
      (push as Optional).sendTestNotification !== undefined
    );
    expect(shown("Trigger a crash")).toBe(true);
  });

  (onboardingEnabled ? it : it.skip)("Replay onboarding marks it unfinished", async () => {
    onboardingStore.setState({ completed: true });
    await mount();
    await act(async () => {
      fireEvent.press(screen.getByText("Replay onboarding"));
    });
    expect(onboardingStore.getState().completed).toBe(false);
  });

  (consentEnabled && privacyCategories.length > 0 ? it : it.skip)(
    "Show consent sheet asks again now",
    async () => {
      await mount();
      await act(async () => {
        fireEvent.press(screen.getByText("Show consent sheet"));
      });
      expect(consent.needsPrompt()).toBe(true);
      consent.markPrompted();
    }
  );

  it("Preview paywall calls payments.presentPaywall()", async () => {
    const presentPaywall = jest.fn(() => Promise.resolve());
    stub(payments as Optional, "presentPaywall", presentPaywall);
    await mount();
    await act(async () => {
      fireEvent.press(screen.getByText("Preview paywall"));
    });
    expect(presentPaywall).toHaveBeenCalledTimes(1);
  });

  it("Open sign-in calls auth.openSignIn()", async () => {
    const openSignIn = jest.fn();
    stub(auth as Optional, "openSignIn", openSignIn);
    await mount();
    await act(async () => {
      fireEvent.press(screen.getByText("Open sign-in"));
    });
    expect(openSignIn).toHaveBeenCalledTimes(1);
  });

  it("Send test notification schedules one in 3 s, or says permission was denied", async () => {
    const show = jest.spyOn(toast, "show").mockImplementation(() => {});
    const send = jest.fn((_content: { title: string; body: string }, _seconds?: number) =>
      Promise.resolve(true)
    );
    stub(push as Optional, "sendTestNotification", send);
    await mount();
    await act(async () => {
      fireEvent.press(screen.getByText("Send test notification"));
    });
    expect(send).toHaveBeenCalledWith({ title: "Test notification", body: expect.any(String) }, 3);
    expect(show).toHaveBeenLastCalledWith({ title: "Notification in 3 s" });

    send.mockResolvedValueOnce(false);
    await act(async () => {
      fireEvent.press(screen.getByText("Send test notification"));
    });
    expect(show).toHaveBeenLastCalledWith({ title: "Permission denied", kind: "error" });
  });

  it("Trigger a crash throws during render", async () => {
    jest.spyOn(console, "error").mockImplementation(() => {});
    await mount();
    await act(async () => {
      fireEvent.press(screen.getByText("Trigger a crash"));
    });
    expect(screen.getByText(/caught: Test crash from Settings/)).toBeTruthy();
  });

  it("lists every EXPO_PUBLIC_* key with set / missing, and app info", async () => {
    await mount();
    for (const entry of envPresence) expect(screen.getByText(entry.key)).toBeTruthy();
    const set = envPresence.filter((e) => e.set).length;
    expect(screen.queryAllByText("Set")).toHaveLength(set);
    expect(screen.queryAllByText("Missing")).toHaveLength(envPresence.length - set);
    for (const title of ["Version", "Build", "Variant", "Runtime version", "Update"]) {
      expect(screen.getByText(title)).toBeTruthy();
    }
  });
});
