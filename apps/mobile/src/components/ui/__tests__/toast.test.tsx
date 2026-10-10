import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { act, render, screen } from "@testing-library/react-native";
import { SafeAreaProvider, initialWindowMetrics } from "react-native-safe-area-context";

import { ThemeProvider, toast, ToastHost } from "@/components/ui";

const METRICS = initialWindowMetrics ?? {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 0, left: 0, right: 0, bottom: 0 },
};

function Host() {
  return (
    <SafeAreaProvider initialMetrics={METRICS}>
      <ThemeProvider>
        <ToastHost />
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

describe("@/components/ui toast", () => {
  beforeEach(() => {
    // RNTL's async render/act settle through microtasks; only fake the macrotask clock.
    jest.useFakeTimers({ doNotFake: ["nextTick", "queueMicrotask"] });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("each toast keeps its own timer when another one is shown", async () => {
    await render(<Host />);

    await act(() => {
      toast.show({ title: "A" });
    });
    await act(() => {
      jest.advanceTimersByTime(2900);
    });
    await act(() => {
      toast.show({ title: "B" });
    });
    expect(screen.getByText("A")).toBeTruthy();

    await act(() => {
      jest.advanceTimersByTime(200); // t = 3100ms
    });
    expect(screen.queryByText("A")).toBeNull();
    expect(screen.getByText("B")).toBeTruthy();

    await act(() => {
      jest.advanceTimersByTime(2900); // B at 3000ms of its own life
    });
    expect(screen.queryByText("B")).toBeNull();
  });

  it("duration <= 0 is sticky until tapped", async () => {
    await render(<Host />);

    await act(() => {
      toast.show({ title: "Sticky", duration: 0 });
    });
    await act(() => {
      jest.advanceTimersByTime(60_000);
    });
    expect(screen.getByText("Sticky")).toBeTruthy();
  });
});
