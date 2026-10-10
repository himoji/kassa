import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { Alert, type AlertButton } from "react-native";

import { confirm } from "@/lib/confirm";

type AlertArgs = [string, string | undefined, AlertButton[] | undefined];

function lastAlert(spy: jest.SpiedFunction<typeof Alert.alert>): AlertArgs {
  const call = spy.mock.calls.at(-1);
  if (!call) throw new Error("Alert.alert was not called");
  return call as unknown as AlertArgs;
}

describe("confirm", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("resolves true when the confirming button is pressed", async () => {
    const spy = jest.spyOn(Alert, "alert").mockImplementation(() => {});
    const result = confirm({ title: "Delete account", confirmLabel: "Delete", destructive: true });

    const [title, , buttons] = lastAlert(spy);
    expect(title).toBe("Delete account");
    const del = buttons?.find((b) => b.text === "Delete");
    expect(del?.style).toBe("destructive");
    del?.onPress?.();

    await expect(result).resolves.toBe(true);
  });

  it("resolves false on cancel", async () => {
    const spy = jest.spyOn(Alert, "alert").mockImplementation(() => {});
    const result = confirm({ title: "Delete account" });

    const [, , buttons] = lastAlert(spy);
    buttons?.find((b) => b.style === "cancel")?.onPress?.();

    await expect(result).resolves.toBe(false);
  });
});
