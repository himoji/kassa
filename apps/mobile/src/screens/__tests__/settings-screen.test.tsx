import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { Alert, Appearance, type AlertButton } from "react-native";

import { onboardingEnabled } from "@/hooks/use-onboarding-redirect";
import { auth } from "@/lib/auth";
import { consentEnabled } from "@/lib/consent";
import { LANGUAGES, setLanguage } from "@/lib/i18n";
import { privacyCategories } from "@/lib/privacy-categories";
import { storage } from "@/lib/storage";
import { consentStore } from "@/stores/consent";
import { SettingsScreen } from "@/screens/settings/settings-screen";
import { themeModeStore } from "@/stores/theme-mode";
import { ThemeProvider } from "@/components/ui";

// "Export my data" writes a file and opens the share sheet; capture what it writes.
const mockExport: { content?: string; uri?: string } = {};
jest.mock("expo-file-system", () => {
  class File {
    uri: string;
    name: string;
    exists = false;
    constructor(dir: { uri: string }, name: string) {
      this.name = name;
      this.uri = `${dir.uri}${name}`;
    }
    create() {}
    write(content: string) {
      mockExport.content = content;
    }
    delete() {}
  }
  return { File, Paths: { cache: { uri: "file:///cache/", list: () => [] } } };
});
jest.mock("expo-sharing", () => ({
  isAvailableAsync: () => Promise.resolve(true),
  shareAsync: (uri: string) => {
    mockExport.uri = uri;
    return Promise.resolve();
  },
}));

// Server-side erasure (backend/api-routes) is the step that must not run on a cancelled delete.
const mockDeleteServerData = jest.fn(() => Promise.resolve());
jest.mock("@/lib/account-data", () => ({ deleteServerData: () => mockDeleteServerData() }));

/** The auth module's optional delete pre-flight (Clerk has one; the shim does not). */
type Preflight = { prepareDeleteAccount?: (o?: { password?: string }) => Promise<void> };
const preflight = auth as Preflight;
const withPreflight = (fn: Preflight["prepareDeleteAccount"]) => {
  const original = preflight.prepareDeleteAccount;
  preflight.prepareDeleteAccount = fn;
  return () => {
    preflight.prepareDeleteAccount = original;
  };
};

// This file ships with every analytics / crash / onboarding option: rows exist only for them.
const hasAnalytics = privacyCategories.includes("analytics");
const hasToggles = consentEnabled && privacyCategories.length > 0;

describe("SettingsScreen", () => {
  let setColorScheme: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    setColorScheme = jest.spyOn(Appearance, "setColorScheme").mockImplementation(() => {});
    themeModeStore.reset();
  });

  afterEach(() => {
    setColorScheme.mockRestore();
  });

  it("pressing Dark sets the theme mode to dark", async () => {
    await render(
      <ThemeProvider>
        <SettingsScreen />
      </ThemeProvider>
    );

    await act(() => {
      fireEvent.press(screen.getByText("Dark"));
    });

    expect(themeModeStore.getState().mode).toBe("dark");
    expect(setColorScheme).toHaveBeenCalledWith("dark");
  });

  // This test ships with every i18n option: with one language the picker is hidden.
  const multiLanguage = LANGUAGES.length > 1;

  (multiLanguage ? it : it.skip)(
    "pressing Español switches the language and re-renders in Spanish",
    async () => {
      await render(
        <ThemeProvider>
          <SettingsScreen />
        </ThemeProvider>
      );
      expect(screen.getByText("Appearance")).toBeTruthy();

      await act(async () => {
        fireEvent.press(screen.getByText("Español"));
      });
      expect(screen.getByText("Apariencia")).toBeTruthy();
      expect(screen.queryByText("Appearance")).toBeNull();

      await act(async () => {
        await setLanguage("en");
      });
      expect(screen.getByText("Appearance")).toBeTruthy();
    }
  );

  (multiLanguage ? it.skip : it)("hides the language picker with a single language", async () => {
    await render(
      <ThemeProvider>
        <SettingsScreen />
      </ThemeProvider>
    );
    expect(screen.queryByText("Language")).toBeNull();
  });

  it("has no account rows while signed out", async () => {
    await render(
      <ThemeProvider>
        <SettingsScreen />
      </ThemeProvider>
    );
    expect(screen.queryByText("Sign out")).toBeNull();
    expect(screen.queryByText("Delete account")).toBeNull();
  });

  it("Delete account asks first, then calls auth.deleteAccount()", async () => {
    const useSession = jest.spyOn(auth, "useSession").mockReturnValue({
      user: { id: "u1", email: "a@b.c" },
      status: "authenticated",
    });
    const deleteAccount = jest.spyOn(auth, "deleteAccount").mockResolvedValue(undefined);
    const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
    const restorePreflight = withPreflight(() => Promise.resolve());

    await render(
      <ThemeProvider>
        <SettingsScreen />
      </ThemeProvider>
    );

    await act(() => {
      fireEvent.press(screen.getByText("Delete account"));
    });
    expect(deleteAccount).not.toHaveBeenCalled();

    mockDeleteServerData.mockClear();
    const buttons = alert.mock.calls.at(-1)?.[2] as AlertButton[] | undefined;
    await act(async () => {
      buttons?.find((b) => b.style === "destructive")?.onPress?.();
    });
    restorePreflight();
    expect(deleteAccount).toHaveBeenCalledTimes(1);
    // Server-side erasure runs first, while the session can still prove who is asking.
    expect(mockDeleteServerData.mock.invocationCallOrder[0]).toBeLessThan(
      deleteAccount.mock.invocationCallOrder[0]
    );

    useSession.mockRestore();
    deleteAccount.mockRestore();
    alert.mockRestore();
  });

  it("Delete account asks for the password when the provider wants a fresh sign-in", async () => {
    const useSession = jest.spyOn(auth, "useSession").mockReturnValue({
      user: { id: "u1", email: "a@b.c" },
      status: "authenticated",
    });
    const deleteAccount = jest
      .spyOn(auth, "deleteAccount")
      .mockRejectedValueOnce(Object.assign(new Error("stale"), { code: "REAUTH_REQUIRED" }))
      .mockResolvedValueOnce(undefined);
    const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
    // A provider without a pre-flight: the re-auth code comes from deleteAccount itself.
    const restorePreflight = withPreflight(undefined);

    await render(
      <ThemeProvider>
        <SettingsScreen />
      </ThemeProvider>
    );
    await act(() => {
      fireEvent.press(screen.getByText("Delete account"));
    });
    const buttons = alert.mock.calls.at(-1)?.[2] as AlertButton[] | undefined;
    await act(async () => {
      buttons?.find((b) => b.style === "destructive")?.onPress?.();
    });
    expect(screen.getByText("Confirm it's you")).toBeTruthy();

    await act(() => {
      fireEvent.changeText(screen.getByPlaceholderText("Password"), "hunter2");
    });
    await act(async () => {
      // The row behind the sheet has the same label; the sheet's button renders last.
      fireEvent.press(screen.getAllByText("Delete account").at(-1)!);
    });
    expect(deleteAccount).toHaveBeenLastCalledWith({ password: "hunter2" });
    expect(deleteAccount).toHaveBeenCalledTimes(2);
    restorePreflight();

    useSession.mockRestore();
    deleteAccount.mockRestore();
    alert.mockRestore();
  });

  it("a cancelled re-authentication erases nothing", async () => {
    const useSession = jest.spyOn(auth, "useSession").mockReturnValue({
      user: { id: "u1", email: "a@b.c" },
      status: "authenticated",
    });
    const prepare = jest
      .fn<(o?: { password?: string }) => Promise<void>>()
      .mockRejectedValue(Object.assign(new Error("stale"), { code: "REAUTH_REQUIRED" }));
    const restorePreflight = withPreflight(prepare);
    const deleteAccount = jest.spyOn(auth, "deleteAccount").mockResolvedValue(undefined);
    const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
    mockDeleteServerData.mockClear();

    await render(
      <ThemeProvider>
        <SettingsScreen />
      </ThemeProvider>
    );
    await act(() => {
      fireEvent.press(screen.getByText("Delete account"));
    });
    const buttons = alert.mock.calls.at(-1)?.[2] as AlertButton[] | undefined;
    await act(async () => {
      buttons?.find((b) => b.style === "destructive")?.onPress?.();
    });
    expect(screen.getByText("Confirm it's you")).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getAllByText("Cancel").at(-1)!);
    });

    expect(prepare).toHaveBeenCalledTimes(1);
    expect(mockDeleteServerData).not.toHaveBeenCalled();
    expect(deleteAccount).not.toHaveBeenCalled();

    restorePreflight();
    useSession.mockRestore();
    deleteAccount.mockRestore();
    alert.mockRestore();
  });

  (hasAnalytics ? it : it.skip)("'Do not sell or share' is a persisted switch", async () => {
    consentStore.reset();
    await render(
      <ThemeProvider>
        <SettingsScreen />
      </ThemeProvider>
    );
    expect(screen.getByText("Do not sell or share my personal information")).toBeTruthy();
    // The last switch in the Privacy card is "Do not sell or share".
    await act(() => {
      fireEvent(screen.getAllByRole("switch").at(-1)!, "valueChange", true);
    });
    expect(consentStore.getState().doNotSell).toBe(true);
  });

  (hasAnalytics ? it.skip : it)(
    "has no 'Do not sell' row without an analytics module",
    async () => {
      await render(
        <ThemeProvider>
          <SettingsScreen />
        </ThemeProvider>
      );
      expect(screen.queryByText("Do not sell or share my personal information")).toBeNull();
    }
  );

  it("'Export my data' shares a my-data-<date>.json file without credentials", async () => {
    const useSession = jest.spyOn(auth, "useSession").mockReturnValue({
      user: { id: "u1", email: "a@b.c" },
      status: "authenticated",
    });
    await storage.setItem("notes", JSON.stringify([{ id: 1 }]));
    await storage.setItem("sb-x-auth-token", JSON.stringify({ access_token: "secret-jwt" }));
    await render(
      <ThemeProvider>
        <SettingsScreen />
      </ThemeProvider>
    );
    await act(async () => {
      fireEvent.press(screen.getByText("Export my data"));
    });
    expect(mockExport.uri).toMatch(/^file:\/\/\/cache\/my-data-\d{4}-\d{2}-\d{2}\.json$/);
    expect(mockExport.content).not.toContain("secret-jwt");
    expect(JSON.parse(mockExport.content ?? "{}")).toMatchObject({
      account: { id: "u1", email: "a@b.c" },
      data: { notes: [{ id: 1 }] },
    });
    useSession.mockRestore();
    await storage.removeItem("notes");
    await storage.removeItem("sb-x-auth-token");
  });

  // The toggles only make sense when the consent module reads them and a category exists.
  (hasToggles ? it : it.skip)("shows a toggle per privacy category", async () => {
    await render(
      <ThemeProvider>
        <SettingsScreen />
      </ThemeProvider>
    );
    for (const title of privacyCategories.map((c) =>
      c === "analytics" ? "Analytics" : "Crash reports"
    )) {
      expect(screen.getByText(title)).toBeTruthy();
    }
  });

  (hasToggles ? it.skip : it)("hides the toggles when there is nothing to consent to", async () => {
    await render(
      <ThemeProvider>
        <SettingsScreen />
      </ThemeProvider>
    );
    expect(screen.queryByText("Crash reports")).toBeNull();
    expect(screen.queryByText("Analytics")).toBeNull();
  });

  it(`${onboardingEnabled ? "shows" : "hides"} "Reset onboarding"`, async () => {
    await render(
      <ThemeProvider>
        <SettingsScreen />
      </ThemeProvider>
    );
    expect(screen.queryByText("Reset onboarding") !== null).toBe(onboardingEnabled);
  });
});
