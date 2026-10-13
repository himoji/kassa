import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";

import { tokenStore } from "@/api/token-store";
import { ThemeProvider } from "@/components/ui";
import { parsePairUrl } from "@/lite/pair";
import { loadServerUrl, normalizeServerUrl } from "@/lite/server-url";
import { loadShortcutToken } from "@/lite/shortcut-token";
import { useSessionStore } from "@/stores/session";
import { PairScreen } from "../pair-screen";

const mockReplace = jest.fn();
let mockParams: { code?: string; server?: string } = {};
jest.mock("expo-router", () => ({
  ...jest.requireActual<object>("expo-router"),
  router: { replace: (href: string) => mockReplace(href) },
  useLocalSearchParams: () => mockParams,
}));

const COMPLETE = {
  user: { id: "11111111-1111-4111-8111-111111111111", displayName: "Zhanel" },
  onboarded: true,
  tokens: {
    accessToken: "access-1",
    accessTokenExpiresAt: "2099-01-01T00:00:00.000Z",
    refreshToken: "refresh-1",
  },
  shortcutToken: "shortcut-secret",
  deviceId: "22222222-2222-4222-8222-222222222222",
  serverUrl: "https://kassa.example.com",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("PairScreen", () => {
  let fetchMock: jest.SpiedFunction<typeof globalThis.fetch>;

  beforeEach(async () => {
    mockReplace.mockClear();
    mockParams = {};
    await tokenStore.clear();
    useSessionStore.getState().setStatus("unauthenticated");
    fetchMock = jest.spyOn(globalThis, "fetch");
  });
  afterEach(() => fetchMock.mockRestore());

  const renderScreen = async () =>
    await render(
      <ThemeProvider>
        <PairScreen />
      </ThemeProvider>
    );

  it("redeems the typed code and stores the session, the Shortcut token and the server", async () => {
    fetchMock.mockResolvedValue(json(200, COMPLETE));
    await renderScreen();

    await fireEvent.changeText(screen.getByPlaceholderText("ABCD2345"), "abcd 2345");
    await fireEvent.changeText(
      screen.getByPlaceholderText("https://kassa.example.com"),
      "https://kassa.example.com/"
    );
    await fireEvent.press(screen.getByText("Pair this iPhone"));

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/activity"));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://kassa.example.com/api/auth/pair/complete");
    expect(JSON.parse(String(init.body))).toMatchObject({ code: "ABCD2345" });
    expect(await tokenStore.load()).toEqual(COMPLETE.tokens);
    expect(await loadShortcutToken()).toBe("shortcut-secret");
    expect(await loadServerUrl()).toBe("https://kassa.example.com");
    expect(useSessionStore.getState().status).toBe("authenticated");
  });

  it("pre-fills from a pairing link but waits for the person to confirm", async () => {
    mockParams = { code: "WXYZ6789", server: "https://kassa.example.com" };
    await renderScreen();
    expect(screen.getByDisplayValue("WXYZ6789")).toBeTruthy();
    expect(screen.getByDisplayValue("https://kassa.example.com")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a short code and a non-https server without calling the API", async () => {
    await renderScreen();
    await fireEvent.changeText(screen.getByPlaceholderText("ABCD2345"), "ABC");
    await fireEvent.press(screen.getByText("Pair this iPhone"));
    expect(screen.getByTestId("pair-error")).toBeTruthy();

    await fireEvent.changeText(screen.getByPlaceholderText("ABCD2345"), "ABCD2345");
    await fireEvent.changeText(
      screen.getByPlaceholderText("https://kassa.example.com"),
      "http://kassa.example.com"
    );
    await fireEvent.press(screen.getByText("Pair this iPhone"));
    expect(screen.getByText("Enter the server address, starting with https://.")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stores nothing when the server refuses the code", async () => {
    fetchMock.mockResolvedValue(json(400, { error: "bad code" }));
    await renderScreen();
    await fireEvent.changeText(screen.getByPlaceholderText("ABCD2345"), "ABCD2345");
    await fireEvent.changeText(
      screen.getByPlaceholderText("https://kassa.example.com"),
      "https://kassa.example.com"
    );
    await fireEvent.press(screen.getByText("Pair this iPhone"));
    await waitFor(() => expect(screen.getByTestId("pair-error")).toBeTruthy());
    expect(mockReplace).not.toHaveBeenCalled();
    expect(await tokenStore.load()).toBeNull();
    expect(useSessionStore.getState().status).toBe("unauthenticated");
  });
});

describe("pairing helpers", () => {
  it("parses kassalite://pair links and rejects others", async () => {
    expect(
      parsePairUrl("kassalite://pair?code=ABCD2345&server=https%3A%2F%2Fk.example.com")
    ).toEqual({
      code: "ABCD2345",
      server: "https://k.example.com",
    });
    expect(parsePairUrl("https://evil.example/pair?code=A&server=B")).toBeNull();
    expect(parsePairUrl("kassalite://other?code=A&server=B")).toBeNull();
  });

  it("accepts only https origins", async () => {
    expect(normalizeServerUrl("https://k.example.com/api/")).toBe("https://k.example.com");
    expect(normalizeServerUrl("http://k.example.com")).toBeNull();
    expect(normalizeServerUrl("https://k.example.com/path")).toBeNull();
  });
});
