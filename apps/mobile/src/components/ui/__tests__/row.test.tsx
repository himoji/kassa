import { describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";

import { Row, Switch, ThemeProvider } from "@/components/ui";

// expo-symbols renders nothing under jest, so icons are invisible to queries.
// Standing in a testID-bearing Text for it is what makes the chevron assertable.
jest.mock("expo-symbols", () => {
  /* eslint-disable @typescript-eslint/no-require-imports -- jest.mock factories are hoisted above imports */
  const mockReact = require("react");
  const { Text } = require("react-native");
  return {
    SymbolView: ({ name }: { name: { ios?: string } }) =>
      mockReact.createElement(Text, { testID: `icon:${name?.ios ?? ""}` }),
  };
});

const CHEVRON = "icon:chevron.forward";

describe("@/components/ui Row", () => {
  it("renders the title and subtitle", async () => {
    await render(
      <ThemeProvider>
        <Row title="Privacy policy" subtitle="Opens in a browser" />
      </ThemeProvider>
    );

    expect(screen.getByText("Privacy policy")).toBeTruthy();
    expect(screen.getByText("Opens in a browser")).toBeTruthy();
  });

  it("renders the leading string as an icon", async () => {
    await render(
      <ThemeProvider>
        <Row title="Website" leading="globe" />
      </ThemeProvider>
    );

    expect(screen.getByTestId("icon:globe")).toBeTruthy();
  });

  it("calls onPress when tapped", async () => {
    const onPress = jest.fn();
    await render(
      <ThemeProvider>
        <Row title="Tap" testID="row" onPress={onPress} />
      </ThemeProvider>
    );

    fireEvent.press(screen.getByTestId("row"));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("does not call onPress when disabled", async () => {
    const onPress = jest.fn();
    await render(
      <ThemeProvider>
        <Row title="Tap" testID="row" onPress={onPress} disabled />
      </ThemeProvider>
    );

    fireEvent.press(screen.getByTestId("row"));
    expect(onPress).not.toHaveBeenCalled();
  });

  it("shows a chevron when pressable with no trailing", async () => {
    await render(
      <ThemeProvider>
        <Row title="Tap" onPress={() => {}} />
      </ThemeProvider>
    );

    expect(screen.getByTestId(CHEVRON)).toBeTruthy();
  });

  it("hides the chevron when a trailing node is given", async () => {
    await render(
      <ThemeProvider>
        <Row
          title="Notifications"
          onPress={() => {}}
          trailing={<Switch value onValueChange={() => {}} />}
        />
      </ThemeProvider>
    );

    expect(screen.queryByTestId(CHEVRON)).toBeNull();
  });

  it("hides the chevron when the row is not pressable", async () => {
    await render(
      <ThemeProvider>
        <Row title="Version" />
      </ThemeProvider>
    );

    expect(screen.queryByTestId(CHEVRON)).toBeNull();
  });

  it("honours an explicit chevron prop", async () => {
    await render(
      <ThemeProvider>
        <Row title="Tap" onPress={() => {}} chevron={false} />
      </ThemeProvider>
    );

    expect(screen.queryByTestId(CHEVRON)).toBeNull();
  });
});
