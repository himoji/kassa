import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import * as Updates from "expo-updates";
import { SafeAreaProvider, initialWindowMetrics } from "react-native-safe-area-context";

import { UpdatesBanner } from "@/components/updates-banner";
import { ThemeProvider } from "@/components/ui";

interface UpdatesState {
  isUpdateAvailable: boolean;
  isUpdatePending: boolean;
  isDownloading: boolean;
}

const updatesState: UpdatesState = {
  isUpdateAvailable: false,
  isUpdatePending: false,
  isDownloading: false,
};

jest.mock("expo-updates", () => ({
  isEnabled: true,
  useUpdates: jest.fn(() => ({ ...updatesState })),
  fetchUpdateAsync: jest.fn(async () => ({ isNew: true })),
  reloadAsync: jest.fn(async () => {}),
  checkForUpdateAsync: jest.fn(async () => ({ isAvailable: false })),
}));

const fetchUpdateAsync = Updates.fetchUpdateAsync as jest.Mock<typeof Updates.fetchUpdateAsync>;
const reloadAsync = Updates.reloadAsync as jest.Mock<typeof Updates.reloadAsync>;

const METRICS = initialWindowMetrics ?? {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 0, left: 0, right: 0, bottom: 0 },
};

function Host() {
  return (
    <SafeAreaProvider initialMetrics={METRICS}>
      <ThemeProvider>
        <UpdatesBanner />
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

describe("UpdatesBanner", () => {
  const g = globalThis as unknown as { __DEV__: boolean };
  const originalDev = g.__DEV__;

  beforeEach(() => {
    g.__DEV__ = false;
    updatesState.isUpdateAvailable = false;
    updatesState.isUpdatePending = false;
    updatesState.isDownloading = false;
    fetchUpdateAsync.mockClear();
    reloadAsync.mockClear();
  });

  afterEach(() => {
    g.__DEV__ = originalDev;
  });

  it("renders nothing when no update is known", async () => {
    await render(<Host />);
    expect(screen.queryByText("Update ready")).toBeNull();
    expect(fetchUpdateAsync).not.toHaveBeenCalled();
  });

  it("downloads an available update in the background without rendering", async () => {
    updatesState.isUpdateAvailable = true;
    await render(<Host />);
    expect(fetchUpdateAsync).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Update ready")).toBeNull();
  });

  it("shows the banner when pending and restarts on press", async () => {
    updatesState.isUpdateAvailable = true;
    updatesState.isUpdatePending = true;
    await render(<Host />);
    expect(fetchUpdateAsync).not.toHaveBeenCalled();
    expect(screen.getByText("Update ready")).toBeTruthy();
    await act(() => {
      fireEvent.press(screen.getByText("Restart"));
    });
    expect(reloadAsync).toHaveBeenCalledTimes(1);
  });

  it("'Later' hides the banner for the session", async () => {
    updatesState.isUpdatePending = true;
    await render(<Host />);
    await act(() => {
      fireEvent.press(screen.getByText("Later"));
    });
    expect(screen.queryByText("Update ready")).toBeNull();
    expect(reloadAsync).not.toHaveBeenCalled();
  });

  it("renders nothing in __DEV__", async () => {
    g.__DEV__ = true;
    updatesState.isUpdatePending = true;
    await render(<Host />);
    expect(screen.queryByText("Update ready")).toBeNull();
  });
});
