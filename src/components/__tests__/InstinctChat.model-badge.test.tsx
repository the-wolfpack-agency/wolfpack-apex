/**
 * @jest-environment jsdom
 *
 * The model that answered is shown in the badge row, not written into the reply.
 *
 * Reported 2026-08-19: the reply text ended with "_Answered by gpt-4o-mini via
 * azure-openai (cheap tier, as requested)._". The operator's words: "the model
 * should be specified for each response next to 'AI Generated', not in the
 * message". Inside the text it copies out with the answer, it sits in the same
 * block as the answer-quality note, and it reads as something the assistant
 * said rather than a fact about the call.
 *
 * The same-shape test as the connector badge, and for the same reason: the
 * component renders fine in isolation and the field is in the JSON, so only an
 * end-to-end render proves the wire is connected.
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

describe("InstinctChat — the model appears as a badge, never in the answer", () => {
  test("an AI answer shows which model produced it", async () => {
    mockApi({
      response: "SpaceX launched a Falcon 9 this morning.",
      source: "ai",
      tokensUsed: 1341,
      conversationId: "c1",
      messageId: "m1",
      model: "gpt-4o-mini",
      provider: "azure-openai",
    });

    const InstinctChat = await importComponent();
    await act(async () => {
      render(<InstinctChat showHistory={false} />);
    });
    await sendMessage("what launched today");

    const badge = await screen.findByTestId("assistant-model-badge");
    expect(badge).toHaveTextContent("gpt-4o-mini");
    // Beside the existing chrome, not instead of it.
    expect(screen.getByText(/AI generated/i)).toBeInTheDocument();
    expect(screen.getByText(/1,341 tokens/)).toBeInTheDocument();
  });

  test("a pinned tier is stated, so routing can be proved by reading the reply", async () => {
    mockApi({
      response: "SpaceX launched a Falcon 9 this morning.",
      source: "ai",
      tokensUsed: 900,
      conversationId: "c1",
      messageId: "m2",
      model: "gpt-4o-mini",
      provider: "azure-openai",
      tierRequested: "cheap",
    });

    const InstinctChat = await importComponent();
    await act(async () => {
      render(<InstinctChat showHistory={false} />);
    });
    await sendMessage("/cheap what launched today");

    const badge = await screen.findByTestId("assistant-model-badge");
    expect(badge).toHaveTextContent("cheap tier, as asked");
  });

  test("THE ANSWER TEXT IS ONLY THE ANSWER", async () => {
    /* The reported bug, stated as an assertion: no attribution prose in the
       message body, wherever the badge ends up. */
    mockApi({
      response: "SpaceX launched a Falcon 9 this morning.",
      source: "ai",
      tokensUsed: 900,
      conversationId: "c1",
      messageId: "m3",
      model: "gpt-4o-mini",
      provider: "azure-openai",
      tierRequested: "cheap",
    });

    const InstinctChat = await importComponent();
    await act(async () => {
      render(<InstinctChat showHistory={false} />);
    });
    await sendMessage("/cheap what launched today");

    await screen.findByTestId("assistant-model-badge");
    expect(screen.queryByText(/Answered by/i)).toBeNull();
    expect(screen.queryByText(/as requested/i)).toBeNull();
  });

  test("a zero-token answer names no model, because none produced it", async () => {
    mockApi({
      response: "Top 3 deals:\n\n1. Acme",
      source: "tool",
      tokensUsed: 0,
      conversationId: "c1",
      messageId: "m4",
    });

    const InstinctChat = await importComponent();
    await act(async () => {
      render(<InstinctChat showHistory={false} />);
    });
    await sendMessage("top 3 deals");

    expect(await screen.findByText(/Zero tokens/i)).toBeInTheDocument();
    expect(screen.queryByTestId("assistant-model-badge")).toBeNull();
  });
});
