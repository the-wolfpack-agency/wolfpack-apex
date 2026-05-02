/** @jest-environment jsdom */
 

import { renderHook, act } from "@testing-library/react";
import { useAdaptivePoll } from "@/lib/hooks/useAdaptivePoll";

jest.useFakeTimers();

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  setVisibility("visible");
});

describe("useAdaptivePoll", () => {
  it("fires callback immediately on mount", () => {
    const cb = jest.fn();
    renderHook(() => useAdaptivePoll(cb));
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("fires every visibleMs while tab is visible", () => {
    const cb = jest.fn();
    renderHook(() =>
      useAdaptivePoll(cb, { visibleMs: 1000, hiddenMs: 9999 }),
    );
    expect(cb).toHaveBeenCalledTimes(1);
    act(() => {
      jest.advanceTimersByTime(1000);
    });
    expect(cb).toHaveBeenCalledTimes(2);
    act(() => {
      jest.advanceTimersByTime(2000);
    });
    expect(cb).toHaveBeenCalledTimes(4);
  });

  it("switches to hiddenMs when the tab becomes hidden", () => {
    const cb = jest.fn();
    renderHook(() =>
      useAdaptivePoll(cb, { visibleMs: 1000, hiddenMs: 5000 }),
    );
    cb.mockClear();
    act(() => {
      setVisibility("hidden");
    });
    // Going hidden does NOT fire (we only fire on becoming visible).
    expect(cb).toHaveBeenCalledTimes(0);
    // Hidden cadence: should fire after 5s, not 1s.
    act(() => {
      jest.advanceTimersByTime(1000);
    });
    expect(cb).toHaveBeenCalledTimes(0);
    act(() => {
      jest.advanceTimersByTime(4000);
    });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("fires immediately when the tab returns to visible", () => {
    const cb = jest.fn();
    renderHook(() =>
      useAdaptivePoll(cb, { visibleMs: 1000, hiddenMs: 5000 }),
    );
    act(() => setVisibility("hidden"));
    cb.mockClear();
    act(() => setVisibility("visible"));
    // Coming back: immediate fire so users see fresh data on tab return.
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("fires on window focus", () => {
    const cb = jest.fn();
    renderHook(() =>
      useAdaptivePoll(cb, { visibleMs: 9999, hiddenMs: 9999 }),
    );
    cb.mockClear();
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("swallows errors thrown by the callback (never breaks the timer)", () => {
    const cb = jest.fn(() => {
      throw new Error("boom");
    });
    expect(() =>
      renderHook(() =>
        useAdaptivePoll(cb, { visibleMs: 1000, hiddenMs: 5000 }),
      ),
    ).not.toThrow();
    act(() => {
      jest.advanceTimersByTime(2000);
    });
    expect(cb).toHaveBeenCalledTimes(3); // mount + 2 ticks; none crashed
  });

  it("cleans up timer + listeners on unmount", () => {
    const cb = jest.fn();
    const { unmount } = renderHook(() =>
      useAdaptivePoll(cb, { visibleMs: 1000, hiddenMs: 5000 }),
    );
    cb.mockClear();
    unmount();
    act(() => {
      jest.advanceTimersByTime(10_000);
      window.dispatchEvent(new Event("focus"));
    });
    expect(cb).toHaveBeenCalledTimes(0);
  });

  it("downshifts to idleMs once isStable returns true for idleAfterStablePolls polls", () => {
    const cb = jest.fn();
    renderHook(() =>
      useAdaptivePoll(cb, {
        visibleMs: 1000,
        hiddenMs: 9999,
        idleMs: 5000,
        idleAfterStablePolls: 3,
        isStable: () => true, // always stable
      }),
    );
    // Mount fires once (stable++ → 1).
    expect(cb).toHaveBeenCalledTimes(1);
    // Two visibleMs ticks (stable → 2, then 3 — threshold reached).
    act(() => jest.advanceTimersByTime(1000));
    act(() => jest.advanceTimersByTime(1000));
    expect(cb).toHaveBeenCalledTimes(3);
    // Next tick is now scheduled at idleMs (5000), not visibleMs (1000).
    act(() => jest.advanceTimersByTime(1000));
    expect(cb).toHaveBeenCalledTimes(3);
    act(() => jest.advanceTimersByTime(4000));
    expect(cb).toHaveBeenCalledTimes(4);
  });

  it("resets idle backoff when isStable returns false", () => {
    let stable = true;
    const cb = jest.fn();
    renderHook(() =>
      useAdaptivePoll(cb, {
        visibleMs: 1000,
        hiddenMs: 9999,
        idleMs: 5000,
        idleAfterStablePolls: 2,
        isStable: () => stable,
      }),
    );
    // Mount stable++ (1), tick stable++ (2 → threshold).
    act(() => jest.advanceTimersByTime(1000));
    expect(cb).toHaveBeenCalledTimes(2);
    // Idle engaged: next tick at 5000ms, not 1000ms.
    act(() => jest.advanceTimersByTime(1000));
    expect(cb).toHaveBeenCalledTimes(2);
    // Mark unstable. Existing idleMs timer still fires once.
    stable = false;
    act(() => jest.advanceTimersByTime(4000));
    expect(cb).toHaveBeenCalledTimes(3);
    // After that fire, stableCount reset to 0 → next tick at visibleMs.
    act(() => jest.advanceTimersByTime(1000));
    expect(cb).toHaveBeenCalledTimes(4);
  });

  it("never engages idle backoff when isStable is omitted", () => {
    const cb = jest.fn();
    renderHook(() =>
      useAdaptivePoll(cb, {
        visibleMs: 1000,
        hiddenMs: 9999,
        idleMs: 5000,
        idleAfterStablePolls: 2,
        // no isStable
      }),
    );
    // 10 polls all at visibleMs.
    for (let i = 0; i < 10; i++) {
      act(() => jest.advanceTimersByTime(1000));
    }
    expect(cb).toHaveBeenCalledTimes(11); // mount + 10 ticks
  });

  it("default visibleMs is 30s (was 5s before optimization)", () => {
    const cb = jest.fn();
    renderHook(() => useAdaptivePoll(cb)); // no opts
    cb.mockClear();
    act(() => jest.advanceTimersByTime(29_999));
    expect(cb).toHaveBeenCalledTimes(0);
    act(() => jest.advanceTimersByTime(1));
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
