/**
 * @jest-environment jsdom
 *
 * InstinctChat — History overlay entry points (header button +
 * `/history` slash command).
 *
 * Focused on the entry-point CONTRACT: button is in the DOM,
 * positioned between the brand and the Suggestions button, slash
 * command is intercepted client-side without ever hitting the
 * /api/assistant POST. Picking a row populates the composer but
 * does NOT auto-submit. The overlay's own a11y + close behavior is
 * tested in AssistantHistoryOverlay.test.tsx.
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
  fetchMock.mockImplementation((url: unknown) => {
    const u = typeof url === "string" ? url : "";
    if (u.includes("/api/assistant/prompt-history")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            prompts: [
              {
                content: "give me insights",
                last_asked_at: new Date(Date.now() - 60_000).toISOString(),
                ask_count: 2,
              },
            ],
          }),
      } as unknown as Response);
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ conversations: [] }),
      text: () => Promise.resolve("{}"),
    } as unknown as Response);
  });
});

async function importComponent() {
  const mod = await import("@/components/InstinctChat");
  return mod.default;
}

test("History header button is in the DOM", async () => {
  const InstinctChat = await importComponent();
  await act(async () => {
    render(<InstinctChat />);
  });
  expect(
    screen.getByTestId("assistant-history-button"),
  ).toBeInTheDocument();
});

test("History button sits to the LEFT of Suggestions in the header", async () => {
  /* Nick's placement: "to the right of the OGIAM Assistant text
   * and left of the ? button". This pin keeps that order stable. */
  const InstinctChat = await importComponent();
  await act(async () => {
    render(<InstinctChat />);
  });
  const historyBtn = screen.getByTestId("assistant-history-button");
  const suggestionsBtn = screen.getByTestId("assistant-suggestions-button");
  // DocumentPosition: 4 = following. History should precede Suggestions.
  // eslint-disable-next-line no-bitwise
  const order =
    historyBtn.compareDocumentPosition(suggestionsBtn) &
    Node.DOCUMENT_POSITION_FOLLOWING;
  expect(order).toBeTruthy();
});

test("History button collapses to icon-only on mobile so the brand doesn't truncate", async () => {
  const InstinctChat = await importComponent();
  await act(async () => {
    render(<InstinctChat />);
  });
  const historyBtn = screen.getByTestId("assistant-history-button");
  const label = historyBtn.querySelector("span");
  expect(label).not.toBeNull();
  expect(label!.className).toContain("hidden");
  expect(label!.className).toContain("sm:inline");
  expect(historyBtn).toHaveAttribute("aria-label", "Show prompt history");
});

test("clicking the History button opens the overlay and fetches /api/assistant/prompt-history", async () => {
  const InstinctChat = await importComponent();
  await act(async () => {
    render(<InstinctChat />);
  });
  expect(screen.queryByTestId("assistant-history-overlay")).toBeNull();

  await act(async () => {
    fireEvent.click(screen.getByTestId("assistant-history-button"));
  });

  await waitFor(() =>
    expect(
      screen.getByTestId("assistant-history-overlay"),
    ).toBeInTheDocument(),
  );

  /* Route was hit. */
  const hit = (fetchMock.mock.calls as Array<[string, RequestInit?]>).some(
    ([u]) => typeof u === "string" && u.includes("/api/assistant/prompt-history"),
  );
  expect(hit).toBe(true);
});

test("typing /history and sending opens the overlay WITHOUT POST-ing to /api/assistant", async () => {
  const InstinctChat = await importComponent();
  await act(async () => {
    render(<InstinctChat />);
  });

  const textarea = await screen.findByPlaceholderText(/ask anything/i);
  await act(async () => {
    fireEvent.change(textarea, { target: { value: "/history" } });
  });
  const send = screen.getByTestId("assistant-send-btn");
  await act(async () => {
    fireEvent.click(send);
  });

  await waitFor(() =>
    expect(
      screen.getByTestId("assistant-history-overlay"),
    ).toBeInTheDocument(),
  );

  const sentToAssistant = (
    fetchMock.mock.calls as Array<[string, RequestInit?]>
  ).some(([url, init]) => {
    const u = typeof url === "string" ? url : "";
    return (
      u.endsWith("/api/assistant") &&
      typeof init?.method === "string" &&
      init.method.toUpperCase() === "POST"
    );
  });
  expect(sentToAssistant).toBe(false);
});

test("picking a prompt populates the composer but does NOT auto-send", async () => {
  const InstinctChat = await importComponent();
  await act(async () => {
    render(<InstinctChat />);
  });

  await act(async () => {
    fireEvent.click(screen.getByTestId("assistant-history-button"));
  });
  await waitFor(() =>
    expect(screen.getByTestId("assistant-history-item-0")).toBeInTheDocument(),
  );

  await act(async () => {
    fireEvent.click(screen.getByTestId("assistant-history-item-0"));
  });

  /* Composer is populated. */
  const textarea = (await screen.findByPlaceholderText(
    /ask anything/i,
  )) as HTMLTextAreaElement;
  await waitFor(() => expect(textarea.value).toBe("give me insights"));

  /* Send was NOT invoked behind the scenes — no POST to /api/assistant. */
  const sentToAssistant = (
    fetchMock.mock.calls as Array<[string, RequestInit?]>
  ).some(([url, init]) => {
    const u = typeof url === "string" ? url : "";
    return (
      u.endsWith("/api/assistant") &&
      typeof init?.method === "string" &&
      init.method.toUpperCase() === "POST"
    );
  });
  expect(sentToAssistant).toBe(false);
});
