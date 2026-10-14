import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import * as Updates from "expo-updates";

import { ThemeProvider } from "@/components/ui";
import { UpdatesSection } from "../updates-section";

const mockUpdates = {
  isEnabled: true,
  isEmbeddedLaunch: true,
  updateId: null as string | null,
  createdAt: null as Date | null,
  channel: "lite",
  runtimeVersion: "1.3.0",
};

jest.mock("expo-updates", () => ({
  get isEnabled() {
    return mockUpdates.isEnabled;
  },
  get isEmbeddedLaunch() {
    return mockUpdates.isEmbeddedLaunch;
  },
  get updateId() {
    return mockUpdates.updateId;
  },
  get createdAt() {
    return mockUpdates.createdAt;
  },
  get channel() {
    return mockUpdates.channel;
  },
  get runtimeVersion() {
    return mockUpdates.runtimeVersion;
  },
  checkForUpdateAsync: jest.fn(async () => ({ isAvailable: false })),
  fetchUpdateAsync: jest.fn(async () => ({ isNew: true })),
  reloadAsync: jest.fn(async () => {}),
}));

const checkForUpdateAsync = Updates.checkForUpdateAsync as unknown as jest.Mock<
  () => Promise<{ isAvailable: boolean }>
>;
const fetchUpdateAsync = Updates.fetchUpdateAsync as unknown as jest.Mock;
const reloadAsync = Updates.reloadAsync as unknown as jest.Mock;

async function renderSection() {
  await render(
    <ThemeProvider>
      <UpdatesSection />
    </ThemeProvider>
  );
}

describe("UpdatesSection", () => {
  const g = globalThis as unknown as { __DEV__: boolean };
  const originalDev = g.__DEV__;

  beforeEach(() => {
    g.__DEV__ = false;
    mockUpdates.isEnabled = true;
    mockUpdates.isEmbeddedLaunch = true;
    mockUpdates.updateId = null;
    checkForUpdateAsync.mockClear();
    fetchUpdateAsync.mockClear();
    reloadAsync.mockClear();
  });

  afterEach(() => {
    g.__DEV__ = originalDev;
  });

  it("says updates are off when the build has no update URL", async () => {
    mockUpdates.isEnabled = false;
    await renderSection();
    expect(screen.getByText(/Over-the-air updates are off in this build/)).toBeTruthy();
    expect(screen.queryByText("Check for updates")).toBeNull();
  });

  it("shows the channel, version and the embedded bundle", async () => {
    await renderSection();
    expect(
      screen.getByText("Channel lite, version 1.3.0. Running the bundle built in Xcode.")
    ).toBeTruthy();
  });

  it("downloads and restarts into an available update", async () => {
    checkForUpdateAsync.mockResolvedValueOnce({ isAvailable: true });
    await renderSection();
    await fireEvent.press(screen.getByText("Check for updates"));
    await waitFor(() => expect(reloadAsync).toHaveBeenCalledTimes(1));
    expect(fetchUpdateAsync).toHaveBeenCalledTimes(1);
  });

  it("does not restart when there is nothing new", async () => {
    await renderSection();
    await fireEvent.press(screen.getByText("Check for updates"));
    await waitFor(() => expect(checkForUpdateAsync).toHaveBeenCalledTimes(1));
    expect(fetchUpdateAsync).not.toHaveBeenCalled();
    expect(reloadAsync).not.toHaveBeenCalled();
  });
});
