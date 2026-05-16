/**
 * @jest-environment jsdom
 *
 * InstinctChat — connector-source badge E2E test.
 *
 * This is the test that should have shipped with the badge feature and
 * would have caught the May 16 regression where the API returned
 * `connectorSource: "salesforce"` but the chat surface rendered no
 * badge. The bug was invisible to unit tests (badge component renders
 * fine in isolation) and to API contract tests (the field is in the
 * JSON). Only an end-to-end render proves the wire is connected.
 *
 * Flow under test:
 *   1. User types "top 3 deals"
 *   2. API responds with { response, source: "tool", connectorSource: "salesforce", ... }
 *   3. InstinctChat constructs Message + renders
 *   4. ASSERT: ConnectorBadge with testid "connector-badge-salesforce"
 *      is in the DOM
 *   5. ASSERT: the visible body does NOT contain "*— Source:" (badge
 *      replaces the inline footer, doesn't coexist with it)
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
  if (!(Element.prototype as unknown as { scrollIntoView?: () => void }).scrollIntoView) {
    (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView =
      () => undefined;
  }
  Object.defineProperty(window, "localStorage", {
    value: {
      _store: { instinct_token: "t" } as Record<string, string>,
      getItem(this: { _store: Record<string, string> }, k: string) {
        return this._store[k] ?? null;
      },
      setItem(this: { _store: Record<string, string> }, k: string, v: string) {
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
  Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
});

beforeEach(() => {
  fetchMock.mockReset();
});

async function importComponent() {
  const mod = await import("@/components/InstinctChat");
  return mod.default;
}

/** Build a fetch impl that:
 *   - returns empty conversation list on the conversations GET
 *   - returns the supplied assistant response on the chat POST
 *   - 200/empty on everything else (analytics pings, etc.) */
function mockApi(assistantPayload: Record<string, unknown>) {
  fetchMock.mockImplementation((input: RequestInfo, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    const method = init?.method ?? "GET";
    if (url.includes("/api/assistant") && method === "POST" && !url.includes("conversations=true")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(assistantPayload),
        text: () => Promise.resolve(JSON.stringify(assistantPayload)),
      } as unknown as Response);
    }
    if (url.includes("/api/assistant") && url.includes("conversations=true")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ conversations: [] }),
        text: () => Promise.resolve("{\"conversations\":[]}"),
      } as unknown as Response);
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
      text: () => Promise.resolve("{}"),
    } as unknown as Response);
  });
}

async function sendMessage(text: string) {
  const textarea = await screen.findByPlaceholderText(/ask anything/i) as HTMLTextAreaElement;
  /* React controlled-input dance: set the native value descriptor THEN
     dispatch the input event so React's synthetic onChange picks it up. */
  const nativeInputSetter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype, "value",
  )?.set;
  await act(async () => {
    nativeInputSetter?.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const send = screen
    .getAllByRole("button")
    .find((b) => b.querySelector("svg path[d^='M6 12']") !== null)!;
  await act(async () => {
    fireEvent.click(send);
  });
}

describe("InstinctChat — connector badge renders after a successful tool dispatch", () => {
  test("Salesforce: API returns connectorSource → badge appears in DOM", async () => {
    mockApi({
      response: "Top 3 deals:\n\n1. Acme",
      source: "tool",
      tokensUsed: 0,
      conversationId: "c1",
      messageId: "m1",
      connectorSource: "salesforce",
    });

    const InstinctChat = await importComponent();
    await act(async () => {
      render(<InstinctChat showHistory={false} />);
    });

    await sendMessage("top 3 deals");

    /* The badge must be in the DOM. If this fails, the regression is
       in the wiring between the API response and the rendered chat. */
    await waitFor(() => {
      expect(screen.getByTestId("connector-badge-salesforce")).toBeInTheDocument();
    });
    expect(screen.getByTestId("connector-badge-salesforce").textContent).toBe("Salesforce");

    /* Visible body must NOT contain the legacy inline footer. */
    expect(screen.queryByText(/\*— Source:/)).not.toBeInTheDocument();
  });

  test("GitHub: API returns connectorSource='github' → GitHub badge appears", async () => {
    mockApi({
      response: "Recent 5 workflow runs in `wolfpack-apex`.",
      source: "tool",
      tokensUsed: 0,
      conversationId: "c2",
      messageId: "m2",
      connectorSource: "github",
    });

    const InstinctChat = await importComponent();
    await act(async () => {
      render(<InstinctChat showHistory={false} />);
    });

    await sendMessage("failed CI in wolfpack-apex");

    await waitFor(() => {
      expect(screen.getByTestId("connector-badge-github")).toBeInTheDocument();
    });
    expect(screen.getByTestId("connector-badge-github").textContent).toBe("GitHub");
  });

  test("No connectorSource → no badge (non-CRM answers don't get a vendor pill)", async () => {
    mockApi({
      response: "Your calendar shows one meeting at 2pm.",
      source: "tool",
      tokensUsed: 0,
      conversationId: "c3",
      messageId: "m3",
      /* no connectorSource */
    });

    const InstinctChat = await importComponent();
    await act(async () => {
      render(<InstinctChat showHistory={false} />);
    });

    await sendMessage("am I free thursday");

    /* Wait for the answer to land, then assert badge is absent. */
    await waitFor(() => {
      expect(screen.getByText(/Your calendar shows one meeting/)).toBeInTheDocument();
    });
    expect(screen.queryByTestId(/^connector-badge-/)).toBeNull();
  });

  test("Reloaded conversation: connector_source in metadata hydrates the badge", async () => {
    /* The reload path is the historical-message path — the API returns
       AssistantMessage[] including metadata. Verify the badge renders
       from `metadata.connector_source` when the top-level field is
       absent (DB rows persist via metadata, not a dedicated column). */
    const messages = [
      {
        id: "u1",
        role: "user",
        content: "top 3 deals",
        tokensUsed: 0,
        timestamp: "2026-05-16T11:00:00Z",
      },
      {
        id: "m1",
        role: "assistant",
        content: "Top 3 deals:\n\n1. Acme",
        source: "tool",
        tokensUsed: 0,
        timestamp: "2026-05-16T11:00:01Z",
        metadata: { connector_source: "salesforce" },
        /* note: connectorSource NOT at top level — that's the column
           that doesn't exist on instinct_messages */
      },
    ];

    fetchMock.mockImplementation((input: RequestInfo) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("conversationId=convX")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ conversationId: "convX", messages }),
          text: () => Promise.resolve(""),
        } as unknown as Response);
      }
      if (url.includes("conversations=true")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              conversations: [
                {
                  id: "convX",
                  title: "Top 3 deals",
                  last_message_at: "2026-05-16T11:00:01Z",
                  message_count: 2,
                },
              ],
            }),
          text: () => Promise.resolve(""),
        } as unknown as Response);
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve(""),
      } as unknown as Response);
    });

    const InstinctChat = await importComponent();
    await act(async () => {
      render(<InstinctChat showHistory={true} />);
    });

    /* Click the conversation in the sidebar — there should only be one. */
    const convoButton = await screen.findByRole("button", { name: /Top 3 deals/i });
    await act(async () => {
      fireEvent.click(convoButton);
    });

    /* Wait for the historical assistant message to render, then assert
       the badge is in the DOM, hydrated from metadata. */
    await waitFor(() => {
      expect(screen.getByText(/Top 3 deals:/)).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByTestId("connector-badge-salesforce")).toBeInTheDocument();
    });
  });
});
