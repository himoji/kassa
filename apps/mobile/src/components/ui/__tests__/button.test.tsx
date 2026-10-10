import { describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";

import { Button, ThemeProvider } from "@/components/ui";

describe("@/components/ui Button", () => {
  it("calls onPress when tapped", async () => {
    const onPress = jest.fn();
    await render(
      <ThemeProvider>
        <Button onPress={onPress}>Tap</Button>
      </ThemeProvider>
    );

    fireEvent.press(screen.getByText("Tap"));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("does not call onPress when disabled", async () => {
    const onPress = jest.fn();
    await render(
      <ThemeProvider>
        <Button onPress={onPress} disabled>
          Tap
        </Button>
      </ThemeProvider>
    );

    fireEvent.press(screen.getByText("Tap"));
    expect(onPress).not.toHaveBeenCalled();
  });

  it("shows a spinner when loading", async () => {
    await render(
      <ThemeProvider>
        <Button onPress={() => {}} loading>
          Tap
        </Button>
      </ThemeProvider>
    );

    expect(screen.getByRole("button", { busy: true })).toBeTruthy();
    expect(JSON.stringify(screen.toJSON())).toContain("ActivityIndicator");
  });
});
