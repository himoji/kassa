import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { act, fireEvent, render, screen } from "@testing-library/react-native";

import { PasskeyButton } from "@/components/kassa/passkey-button";
import { ThemeProvider } from "@/components/ui";
import { useSessionStore } from "@/stores/session";

let mockDevLogin = true;
jest.mock("@/api/hooks/auth", () => ({
  useDemoAvailability: () => ({ data: { enabled: true, devLogin: mockDevLogin } }),
}));
const mockArm = jest.fn();
jest.mock("@/api/passkey-sign", () => ({ armDevPasskey: () => mockArm() }));

const onPress = jest.fn();
const renderButton = () =>
  render(
    <ThemeProvider>
      <PasskeyButton onPress={onPress}>Approve with passkey</PasskeyButton>
    </ThemeProvider>
  );

describe("PasskeyButton", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDevLogin = true;
    useSessionStore.getState().setDev(false);
  });

  it("dev build + dev sign-in session: the Dev button arms the dev passkey, then runs the same action", async () => {
    await act(async () => useSessionStore.getState().setDev(true));
    await renderButton();
    await fireEvent.press(screen.getByText("Dev"));
    expect(mockArm).toHaveBeenCalledTimes(1);
    expect(onPress).toHaveBeenCalledTimes(1);

    await fireEvent.press(screen.getByText("Approve with passkey"));
    expect(mockArm).toHaveBeenCalledTimes(1);
    expect(onPress).toHaveBeenCalledTimes(2);
  });

  it("no Dev button without dev sign-in on the server", async () => {
    mockDevLogin = false;
    await renderButton();
    expect(screen.queryByText("Dev")).toBeNull();
  });

  it("no Dev button in a session signed in with a real passkey (the server refuses it: NOT_DEV_SESSION)", async () => {
    await renderButton();
    expect(screen.queryByText("Dev")).toBeNull();
  });
});
