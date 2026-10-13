import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";

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

  it("dev build + dev sign-in server: the Dev button arms the dev passkey, then runs the same action", async () => {
    await renderButton();
    fireEvent.press(screen.getByText("Dev"));
    expect(mockArm).toHaveBeenCalledTimes(1);
    expect(onPress).toHaveBeenCalledTimes(1);

    fireEvent.press(screen.getByText("Approve with passkey"));
    expect(mockArm).toHaveBeenCalledTimes(1);
    expect(onPress).toHaveBeenCalledTimes(2);
  });

  it("no Dev button without dev sign-in on the server, or in a dev-login session", async () => {
    mockDevLogin = false;
    await renderButton();
    expect(screen.queryByText("Dev")).toBeNull();

    mockDevLogin = true;
    useSessionStore.getState().setDev(true);
    await renderButton();
    expect(screen.queryByText("Dev")).toBeNull();
  });
});
