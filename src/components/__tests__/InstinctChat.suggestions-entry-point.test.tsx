/**
 * @jest-environment jsdom
 *
 * InstinctChat — Suggestions overlay entry points (header button +
 * /help and /suggestions slash commands).
 *
 * Focused on the entry-point CONTRACT: button is in the DOM, slash
 * command is intercepted client-side without ever hitting the
 * /api/assistant POST. The overlay's own a11y + close behavior is
 * tested in AssistantSuggestionsOverlay.test.tsx.
 */

import "fake-indexeddb/auto";
import "@testing-library/jest-dom";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

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

test("Suggestions header button is in the DOM", async () => {
  const InstinctChat = await importComponent();
  await act(async () => {
    render(<InstinctChat />);
  });
  expect(
    screen.getByTestId("assistant-suggestions-button"),
  ).toBeInTheDocument();
});

test("clicking the Suggestions button opens the overlay", async () => {
  const InstinctChat = await importComponent();
  await act(async () => {
    render(<InstinctChat />);
  });
  expect(
    screen.queryByTestId("assistant-suggestions-overlay"),
  ).toBeNull();
  await act(async () => {
    fireEvent.click(screen.getByTestId("assistant-suggestions-button"));
  });
  await waitFor(() =>
    expect(
      screen.getByTestId("assistant-suggestions-overlay"),
    ).toBeInTheDocument(),
  );
});

test.each(["/help", "/suggestions", "/HELP"])(
  "typing %s and pressing send opens the overlay WITHOUT hitting /api/assistant",
  async (cmd) => {
    const InstinctChat = await importComponent();
    await act(async () => {
      render(<InstinctChat />);
    });

    const textarea = await screen.findByPlaceholderText(/ask anything/i);
    await act(async () => {
      fireEvent.change(textarea, { target: { value: cmd } });
    });
    const send = screen.getByTestId("assistant-send-btn");
    await act(async () => {
      fireEvent.click(send);
    });

    await waitFor(() =>
      expect(
        screen.getByTestId("assistant-suggestions-overlay"),
      ).toBeInTheDocument(),
    );

    // None of the fetch calls should be a POST to /api/assistant.
    const calls = fetchMock.mock.calls as Array<[string, RequestInit?]>;
    const sentToAssistant = calls.some(([url, init]) => {
      const u = typeof url === "string" ? url : "";
      return u.includes("/api/assistant") && init?.method === "POST";
    });
    expect(sentToAssistant).toBe(false);
  },
);
