import { describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import type { DataChoices } from "@kassa/shared";

import { ThemeProvider } from "@/components/ui";

import { ChoiceCard, shiftDate } from "../choice-card";

const base: DataChoices = {
  id: "pick1",
  kind: "choice",
  prompt: "Which account?",
  options: [
    { id: "a", label: "Kaspi", value: "kaspi" },
    { id: "b", label: "Halyk", value: "halyk" },
  ],
};

const wrap = (part: DataChoices, onAnswer = jest.fn(), disabled = false) =>
  render(
    <ThemeProvider>
      <ChoiceCard part={part} onAnswer={onAnswer} disabled={disabled} />
    </ThemeProvider>
  );

describe("ChoiceCard", () => {
  it("renders the prompt and options; a tap answers with label + optionId", async () => {
    const onAnswer = jest.fn();
    await wrap(base, onAnswer);
    expect(screen.getByText("Which account?")).toBeTruthy();
    await fireEvent.press(screen.getByText("Halyk"));
    expect(onAnswer).toHaveBeenCalledWith({
      text: "Halyk",
      choice: { id: "pick1", optionId: "b" },
    });
  });

  it("multi toggles chips and confirms optionIds", async () => {
    const onAnswer = jest.fn();
    await wrap({ ...base, multi: true }, onAnswer);
    await fireEvent.press(screen.getByText("Kaspi"));
    await fireEvent.press(screen.getByText("Halyk"));
    expect(onAnswer).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByText("Confirm"));
    expect(onAnswer).toHaveBeenCalledWith({
      text: "Kaspi, Halyk",
      choice: { id: "pick1", optionIds: ["a", "b"] },
    });
  });

  it("confirm kind shows its buttons", async () => {
    const onAnswer = jest.fn();
    await wrap(
      {
        ...base,
        kind: "confirm",
        options: [
          { id: "y", label: "Yes", value: "yes" },
          { id: "n", label: "No", value: "no" },
        ],
      },
      onAnswer
    );
    await fireEvent.press(screen.getByText("No"));
    expect(onAnswer).toHaveBeenCalledWith({ text: "No", choice: { id: "pick1", optionId: "n" } });
  });

  it("amount steps by stepMinor and sends integer minor units", async () => {
    const onAnswer = jest.fn();
    await wrap(
      {
        ...base,
        kind: "amount",
        options: [],
        amount: { currency: "EUR", defaultMinor: 1000, stepMinor: 500, maxMinor: 1500 },
      },
      onAnswer
    );
    await fireEvent.press(screen.getByText("+"));
    await fireEvent.press(screen.getByText("+")); // clamped at max
    await fireEvent.press(screen.getByText("Confirm"));
    const call = onAnswer.mock.calls[0]![0] as { choice: { value: string } };
    expect(call.choice).toEqual({ id: "pick1", value: "1500" });
  });

  it("date moves by days and sends YYYY-MM-DD", async () => {
    const onAnswer = jest.fn();
    await wrap(
      { ...base, kind: "date", options: [], date: { default: "2026-10-13", max: "2026-10-20" } },
      onAnswer
    );
    await fireEvent.press(screen.getByText("+7 days"));
    await fireEvent.press(screen.getByText("+7 days")); // clamped to max
    await fireEvent.press(screen.getByText("Confirm"));
    expect(onAnswer).toHaveBeenCalledWith({
      text: "2026-10-20",
      choice: { id: "pick1", value: "2026-10-20" },
    });
    expect(shiftDate("2026-02-28", 1)).toBe("2026-03-01");
  });

  it("is read-only when the part has an answer", async () => {
    const onAnswer = jest.fn();
    await wrap({ ...base, answer: { optionIds: ["a"], label: "Kaspi" } }, onAnswer);
    expect(screen.getByText("Answered: Kaspi")).toBeTruthy();
    await fireEvent.press(screen.getByText("Halyk"));
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it("locks after a local answer and when disabled", async () => {
    const onAnswer = jest.fn();
    await wrap(base, onAnswer);
    await fireEvent.press(screen.getByText("Kaspi"));
    await fireEvent.press(screen.getByText("Halyk"));
    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Answered: Kaspi")).toBeTruthy();

    const other = jest.fn();
    await wrap(base, other, true);
    await fireEvent.press(screen.getAllByText("Halyk").at(-1)!);
    expect(other).not.toHaveBeenCalled();
  });

  it("hints that typing works with allowOther", async () => {
    await wrap({ ...base, allowOther: true });
    expect(screen.getByText("Or type your own answer below.")).toBeTruthy();
  });
});
