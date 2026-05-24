/**
 * @jest-environment jsdom
 *
 * Regression test for 2026-05-24 mobile composer cutoff. iOS Safari's
 * bottom chrome (collapsed URL bar + toolbar) was overlapping the
 * "Ask anything…" input. Fix: composer wrapper uses
 * `pb-[max(0.75rem,env(safe-area-inset-bottom))]` AND the inline
 * container uses `100dvh` not `100vh`.
 *
 * jsdom can't execute env(safe-area-inset-bottom), but we CAN assert
 * the class string contains the safe-area utility — that's enough to
 * fail loudly if someone refactors it back to plain `py-3`.
 */

import "@testing-library/jest-dom";
import { act, render } from "@testing-library/react";

const fetchMock = jest.fn();

beforeAll(() => {
  global.fetch = fetchMock as unknown as typeof fetch;
  if (
    !(Element.prototype as unknown as { scrollIntoView?: () => void })
      .scrollIntoView
  ) {
    (Element.prototype as unknown as { scrollIntoView: () => void })
      .scrollIntoView = () => undefined;
  }
  Object.defineProperty(window, "localStorage", {
    value: {
      _store: { instinct_token: "t" } as Record<string, string>,
      getItem(this: { _store: Record<string, string> }, k: string) {
        return this._store[k] ?? null;
      },
      setItem(
        this: { _store: Record<string, string> },
        k: string,
        v: string,
      ) {
        this._store[k] = v;
      },
      removeItem(this: { _store: Record<string, string> }, k: string) {
        delete this._store[k];
      },
      clear(this: { _store: Record<string, string> }) {
        this._store = {};
      },
    },
    writable: true,
  });
});

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ conversations: [] }),
      text: () => Promise.resolve("{}"),
    } as unknown as Response),
  );
});

async function importComponent() {
  const mod = await import("@/components/InstinctChat");
  return mod.default;
}

test("composer wrapper applies safe-area-inset bottom padding (iOS Safari chrome clearance)", async () => {
  const InstinctChat = await importComponent();
  let container: HTMLElement | null = null;
  await act(async () => {
    const result = render(<InstinctChat />);
    container = result.container;
  });
  /* The composer wrapper is the only element with the
   * env(safe-area-inset-bottom) utility — assert it's present. */
  const safeAreaEls = (container as unknown as HTMLElement).querySelectorAll(
    "[class*='env(safe-area-inset-bottom)']",
  );
  expect(safeAreaEls.length).toBeGreaterThan(0);
});

test("inline container uses 100dvh not 100vh so iOS chrome doesn't push the composer offscreen", async () => {
  const InstinctChat = await importComponent();
  let container: HTMLElement | null = null;
  await act(async () => {
    const result = render(<InstinctChat />);
    container = result.container;
  });
  /* Find any element with the inline height style. */
  const allDivs = (container as unknown as HTMLElement).querySelectorAll("div");
  const heights: string[] = [];
  allDivs.forEach((d) => {
    const h = (d as HTMLElement).style.height;
    if (h) heights.push(h);
  });
  // At least one element should have dvh-based height; none should still
  // be using bare 100vh in the calc.
  const usesDvh = heights.some((h) => h.includes("100dvh"));
  const stillUsesVhCalc = heights.some(
    (h) => h.includes("100vh") && h.includes("calc"),
  );
  expect(usesDvh).toBe(true);
  expect(stillUsesVhCalc).toBe(false);
});
