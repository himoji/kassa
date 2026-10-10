import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { act, renderHook } from "@testing-library/react-native";

import { auth, type Session } from "@/lib/auth";

import { useSignOutCleanup } from "../use-sign-out-cleanup";

const mockWipe = jest.fn(() => Promise.resolve([] as string[]));
jest.mock("@/lib/privacy", () => ({ wipeLocalData: () => mockWipe() }));

const SIGNED_IN: Session = { user: { id: "u1" }, status: "authenticated" };
const SIGNED_OUT: Session = { user: null, status: "unauthenticated" };
const LOADING: Session = { user: null, status: "loading" };

describe("useSignOutCleanup", () => {
  let session: Session;
  beforeEach(() => {
    mockWipe.mockClear();
    session = LOADING;
    jest.spyOn(auth, "useSession").mockImplementation(() => session);
  });

  it("wipes local data on every sign-out, not on a signed-out start", async () => {
    const { rerender } = await renderHook(() => useSignOutCleanup());
    session = SIGNED_OUT;
    await act(() => rerender({}));
    expect(mockWipe).not.toHaveBeenCalled();

    session = SIGNED_IN;
    await act(() => rerender({}));
    session = SIGNED_OUT;
    await act(() => rerender({}));
    expect(mockWipe).toHaveBeenCalledTimes(1);

    // Signing in and out again (session expiry, a second account) wipes again.
    session = SIGNED_IN;
    await act(() => rerender({}));
    session = SIGNED_OUT;
    await act(() => rerender({}));
    expect(mockWipe).toHaveBeenCalledTimes(2);
  });
});
