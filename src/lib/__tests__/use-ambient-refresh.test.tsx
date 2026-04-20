/**
 * @jest-environment jsdom
 *
 * useAmbientRefresh — hook wires runSessionWarmPass + startIdleRefresh
 * into a dashboard mount. We mock the ambient-refresh module so the
 * hook is unit-tested without touching the underlying wrappers/IDB.
 */

import "@testing-library/jest-dom";
import { act, renderHook } from "@testing-library/react";

// Mock the orchestrator module so we can assert the hook's lifecycle
// contract (mount → both calls, unmount → abort signal + stop).
const runSessionWarmPass = jest.fn();
const startIdleRefresh = jest.fn();
const stopSpy = jest.fn();

jest.mock("@/lib/ambient-refresh", () => ({
  runSessionWarmPass: (...args: unknown[]) => runSessionWarmPass(...args),
  startIdleRefresh: (...args: unknown[]) => startIdleRefresh(...args),
}));

import { useAmbientRefresh } from "@/lib/hooks/useAmbientRefresh";

function setOnline(value: boolean) {
  Object.defineProperty(window.navigator, "onLine", {
    configurable: true,
    value,
  });
}

beforeEach(() => {
  runSessionWarmPass.mockReset();
  startIdleRefresh.mockReset();
  stopSpy.mockReset();

  runSessionWarmPass.mockResolvedValue([]);
  startIdleRefresh.mockImplementation(() => ({ stop: stopSpy }));

  setOnline(true);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("useAmbientRefresh", () => {
  it("kicks off warm pass + idle refresh on mount when online", () => {
    const { unmount } = renderHook(() => useAmbientRefresh());

    expect(runSessionWarmPass).toHaveBeenCalledTimes(1);
    // Signal is an AbortSignal from the controller created in the hook.
    const warmCallArgs = runSessionWarmPass.mock.calls[0][0] as {
      signal: AbortSignal;
    };
    expect(warmCallArgs.signal).toBeInstanceOf(AbortSignal);

    expect(startIdleRefresh).toHaveBeenCalledTimes(1);
    const idleCallArgs = startIdleRefresh.mock.calls[0][0] as {
      signal: AbortSignal;
    };
    expect(idleCallArgs.signal).toBeInstanceOf(AbortSignal);

    unmount();
  });

  it("skips the warm pass when navigator.onLine is false but still starts idle refresh", () => {
    setOnline(false);
    const { unmount } = renderHook(() => useAmbientRefresh());

    expect(runSessionWarmPass).not.toHaveBeenCalled();
    expect(startIdleRefresh).toHaveBeenCalledTimes(1);

    unmount();
  });

  it("unmount aborts the controller + stops the idle handle", () => {
    const { unmount } = renderHook(() => useAmbientRefresh());

    const idleCallArgs = startIdleRefresh.mock.calls[0][0] as {
      signal: AbortSignal;
    };
    expect(idleCallArgs.signal.aborted).toBe(false);

    unmount();

    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(idleCallArgs.signal.aborted).toBe(true);
  });

  it("online event triggers a fresh warm pass", () => {
    setOnline(false);
    const { unmount } = renderHook(() => useAmbientRefresh());

    // Initial mount skipped warm pass due to offline.
    expect(runSessionWarmPass).not.toHaveBeenCalled();

    // Go online + dispatch the event the hook subscribes to.
    setOnline(true);
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    expect(runSessionWarmPass).toHaveBeenCalledTimes(1);

    unmount();
  });

  it("online event after unmount does NOT trigger any more warm passes", () => {
    const { unmount } = renderHook(() => useAmbientRefresh());
    unmount();
    runSessionWarmPass.mockClear();

    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    expect(runSessionWarmPass).not.toHaveBeenCalled();
  });
});
