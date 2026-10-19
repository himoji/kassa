/* eslint-disable @typescript-eslint/no-require-imports -- the form loads after jest.mock, as in the settings smoke test */
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react-native";

import { ThemeProvider } from "@/components/ui";

const mockCreate = jest.fn((body: unknown) => Promise.resolve(body));

jest.mock("@/api/hooks/payees", () => ({
  ...jest.requireActual<Record<string, unknown>>("@/api/hooks/payees"),
  useCreatePayee: () => ({ mutateAsync: mockCreate, isPending: false }),
}));
jest.mock("@/lib/haptics", () => ({
  haptics: { success: jest.fn(), error: jest.fn(), warning: jest.fn(), selection: jest.fn() },
}));
// @expo/ui's SwiftUI/Compose controls have no Jest renderer: a labelled stub per control.
jest.mock("@/components/kassa/native-controls", () => {
  const { Text } = jest.requireActual<typeof import("react-native")>("react-native");
  const Stub = ({ label, testID }: { label: string; testID?: string }) => (
    <Text testID={testID}>{label}</Text>
  );
  return { SettingPicker: Stub, SettingSwitch: Stub, SettingSlider: Stub };
});
jest.mock("@/components/kassa/segmented", () => {
  const { Pressable, Text, View } =
    jest.requireActual<typeof import("react-native")>("react-native");
  return {
    Segmented: ({
      options,
      onChange,
    }: {
      options: { value: string; label: string }[];
      onChange: (v: string) => void;
    }) => (
      <View>
        {options.map((o) => (
          <Pressable key={o.value} onPress={() => onChange(o.value)} testID={`segment-${o.value}`}>
            <Text>{o.label}</Text>
          </Pressable>
        ))}
      </View>
    ),
  };
});

async function renderForm(category = "PEOPLE") {
  const { AddPayeeForm } = require("../add-payee-form");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <AddPayeeForm initialCategory={category} onClose={() => {}} />
      </ThemeProvider>
    </QueryClientProvider>
  );
}

const submit = () => screen.getByRole("button", { name: "Add recipient" });

describe("AddPayeeForm (People)", () => {
  beforeEach(() => {
    mockCreate.mockClear();
  });

  it("shows only how they get paid, the name and the account by default", async () => {
    await renderForm();
    expect(screen.getByTestId("recipient-category-current")).toBeTruthy();
    expect(screen.getByTestId("segment-IBAN")).toBeTruthy();
    expect(screen.getByTestId("segment-KASSA_USER")).toBeTruthy();
    expect(screen.getByTestId("segment-OTHER")).toBeTruthy();
    expect(screen.getByTestId("payee-name")).toBeTruthy();
    expect(screen.getByTestId("payee-iban")).toBeTruthy();
    expect(screen.getByText("New recipients can be paid after 24 hours.")).toBeTruthy();

    for (const hidden of [
      "recipient-relationship",
      "recipient-note",
      "recipient-purpose-code",
      "payee-country",
      "payee-currency",
      "payee-place",
    ]) {
      expect(screen.queryByTestId(hidden)).toBeNull();
    }
    expect(screen.queryByText(/SEPA/)).toBeNull();
    expect(screen.queryByText(/Kazakh banks/)).toBeNull();
    expect(submit().props.accessibilityState?.disabled).toBe(true);
  });

  it("More details reveals the note, the KNP code and the country pickers", async () => {
    await renderForm();
    await fireEvent.press(screen.getByTestId("payee-more-details"));
    expect(screen.getByTestId("recipient-relationship")).toBeTruthy();
    expect(screen.getByTestId("recipient-note")).toBeTruthy();
    expect(screen.getByTestId("recipient-purpose-code")).toBeTruthy();
    expect(screen.getByText("Kazakh banks ask for it: 311 wages, 119 family.")).toBeTruthy();
    expect(screen.getByTestId("payee-country")).toBeTruthy();
    expect(screen.getByTestId("payee-currency")).toBeTruthy();
  });

  it("an IBAN starting HU reads as Hungary · HUF, and Edit opens the pickers", async () => {
    await renderForm();
    await fireEvent.changeText(
      screen.getByTestId("payee-iban"),
      "HU42 1177 3016 1111 1018 0000 0000"
    );
    expect(screen.getByTestId("payee-place").props.children).toBe("Hungary · HUF");
    await fireEvent.changeText(screen.getByTestId("payee-iban"), "DE89 3704 0044 0532 0130 00");
    expect(screen.getByTestId("payee-place").props.children).toBe("Germany · EUR");

    await fireEvent.press(screen.getByTestId("payee-place-edit"));
    expect(screen.queryByTestId("payee-place")).toBeNull();
    expect(screen.getByTestId("payee-country")).toBeTruthy();
    expect(screen.getByTestId("payee-currency")).toBeTruthy();
  });

  it("enables Add recipient once the name and a valid IBAN are in, and sends the inferred place", async () => {
    await renderForm();
    await fireEvent.changeText(screen.getByTestId("payee-name"), "Anna Kovacs");
    await fireEvent.changeText(screen.getByTestId("payee-iban"), "DE89 3704 0044 0532 0130 0");
    await fireEvent(screen.getByTestId("payee-iban"), "blur");
    expect(submit().props.accessibilityState?.disabled).toBe(true);
    expect(
      screen.getByText("This IBAN's check digits don't add up. Check it for a typo.")
    ).toBeTruthy();

    await fireEvent.changeText(screen.getByTestId("payee-iban"), "DE89 3704 0044 0532 0130 00");
    expect(submit().props.accessibilityState?.disabled).toBe(false);
    await fireEvent.press(submit());
    expect(mockCreate).toHaveBeenCalledWith({
      name: "Anna Kovacs",
      kind: "PERSON",
      account: "DE89370400440532013000",
      country: "DE",
      currency: "EUR",
      details: { category: "PEOPLE", relationship: "FAMILY" },
    });
  });

  it("an invalid KNP code keeps More details open and the button disabled", async () => {
    await renderForm();
    await fireEvent.changeText(screen.getByTestId("payee-name"), "Aigerim");
    await fireEvent.changeText(screen.getByTestId("payee-iban"), "DE89 3704 0044 0532 0130 00");
    await fireEvent.press(screen.getByTestId("payee-more-details"));
    await fireEvent.changeText(screen.getByTestId("recipient-purpose-code"), "31");
    await fireEvent.press(screen.getByTestId("payee-more-details"));
    expect(screen.getByTestId("recipient-purpose-code")).toBeTruthy();
    expect(submit().props.accessibilityState?.disabled).toBe(true);
  });

  it("Kassa user asks for a Kassa ID instead of an IBAN", async () => {
    await renderForm();
    await fireEvent.press(screen.getByTestId("segment-KASSA_USER"));
    expect(screen.queryByTestId("payee-iban")).toBeNull();
    expect(screen.getByTestId("payee-kassa-id")).toBeTruthy();
  });
});

describe("AddPayeeForm (required details)", () => {
  it("keeps a category's required field in view and its optional ones behind More details", async () => {
    await renderForm("BILLS");
    expect(screen.getByTestId("recipient-customer-number")).toBeTruthy();
    expect(screen.queryByTestId("recipient-bill-type")).toBeNull();
    await fireEvent.press(screen.getByTestId("payee-more-details"));
    expect(screen.getByTestId("recipient-bill-type")).toBeTruthy();
    expect(screen.getAllByTestId("recipient-customer-number")).toHaveLength(1);
  });
});
