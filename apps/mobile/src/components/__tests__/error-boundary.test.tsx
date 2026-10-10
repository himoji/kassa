import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";

import { ErrorBoundary } from "@/components/error-boundary";
import { crash } from "@/lib/crash";

describe("ErrorBoundary", () => {
  const dev = __DEV__;
  beforeEach(() => {
    jest.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    (globalThis as unknown as { __DEV__: boolean }).__DEV__ = dev;
    jest.restoreAllMocks();
  });

  it("shows the error message in development, reports it, and calls retry on press", async () => {
    const capture = jest.spyOn(crash, "capture").mockImplementation(() => {});
    const retry = jest.fn(() => Promise.resolve());
    const error = new Error("Boom");

    await render(<ErrorBoundary error={error} retry={retry} />);

    expect(screen.getByText("Something went wrong")).toBeTruthy();
    expect(screen.getByText("Boom")).toBeTruthy();
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith(error, { where: "route-error-boundary" });

    fireEvent.press(screen.getByText("Retry"));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("reports again only when a different error arrives", async () => {
    const capture = jest.spyOn(crash, "capture").mockImplementation(() => {});
    const retry = jest.fn(() => Promise.resolve());
    const first = new Error("first");

    const view = await render(<ErrorBoundary error={first} retry={retry} />);
    await view.rerender(<ErrorBoundary error={first} retry={retry} />);
    expect(capture).toHaveBeenCalledTimes(1);

    await view.rerender(<ErrorBoundary error={new Error("second")} retry={retry} />);
    expect(capture).toHaveBeenCalledTimes(2);
    expect(screen.getByText("second")).toBeTruthy();
  });

  it("never shows the raw error message outside development, but logs it", async () => {
    jest.spyOn(crash, "capture").mockImplementation(() => {});
    (globalThis as unknown as { __DEV__: boolean }).__DEV__ = false;
    const error = new Error("SELECT * FROM users WHERE token='secret'");

    await render(<ErrorBoundary error={error} retry={() => Promise.resolve()} />);

    expect(screen.queryByText(error.message)).toBeNull();
    expect(
      screen.getByText("Please try again. If it keeps happening, restart the app.")
    ).toBeTruthy();
    expect(console.error).toHaveBeenCalledWith("[error-boundary]", error);
  });
});
