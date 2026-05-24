/**
 * @jest-environment jsdom
 *
 * InstinctChat — conversations sidebar default visibility.
 *
 * 2026-05-24: the `showHistory` default was flipped from `true` to
 * `false`. The panel JSX + state are still wired so any caller that
 * passes `showHistory={true}` (admin/debug surface) gets the full
 * panel back without other changes. This test pins both directions.
 */

import "fake-indexeddb/auto";
import "@testing-library/jest-dom";
import { act, render, screen, waitFor } from "@testing-library/react";

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
      json: () =>
        Promise.resolve({
          conversations: [
            { id: "c1", title: "what?", messageCount: 268, totalTokens: 0 },
          ],
        }),
      text: () => Promise.resolve("{}"),
    } as unknown as Response),
  );
});

async function importComponent() {
  const mod = await import("@/components/InstinctChat");
  return mod.default;
}

test("sidebar is HIDDEN by default (no `showHistory` prop)", async () => {
  const InstinctChat = await importComponent();
  await act(async () => {
    render(<InstinctChat />);
  });
  // Composer should be present.
  await screen.findByPlaceholderText(/ask anything/i);
  // Sidebar element must not render.
  expect(screen.queryByTestId("conversations-sidebar")).toBeNull();
  // The "what?" title from the mocked conversations payload must not
  // appear anywhere either — confirms the click-into-old-convo entry
  // point is gone.
  expect(screen.queryByText("what?")).toBeNull();
});

test("sidebar still renders when caller explicitly opts in with showHistory={true}", async () => {
  const InstinctChat = await importComponent();
  await act(async () => {
    render(<InstinctChat showHistory={true} />);
  });
  await waitFor(() =>
    expect(screen.queryByTestId("conversations-sidebar")).not.toBeNull(),
  );
});
