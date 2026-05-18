/**
 * @jest-environment jsdom
 *
 * InstinctChat — fallback chip render path.
 *
 * Locks the contract: when the server returns `fallbackChips: string[]`
 * on a low-confidence / fallback response, the chat bubble renders
 * a clickable chip row. Clicking a chip fills the composer with the
 * prompt text and fires `assistant.fallback_chip_clicked` analytics.
 *
 * Non-fallback responses (those without `fallbackChips`) must NOT
 * render the chip row.
 */

import "fake-indexeddb/auto";
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

const fetchMock = jest.fn();

beforeAll(() => {
  global.fetch = fetchMock as unknown as typeof fetch;
  if (!(Element.prototype as unknown as { scrollIntoView?: () => void }).scrollIntoView) {
    (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView =
      () => undefined;
  }
  Object.defineProperty(window, "localStorage", {
    value: {
      _store: { instinct_token: "t", instinct_welcome_seen: "1" } as Record<string, string>,
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

async function typeAndSend(text: string) {
  const textarea = (await screen.findByTestId("assistant-composer-input")) as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    fireEvent.click(screen.getByTestId("assistant-send-btn"));
  });
}

describe("InstinctChat — fallback chips render when server includes them", () => {
  test("fallbackChips on the response → chip row appears below the bubble", async () => {
    mockApi({
      response: "I'm not sure how to help with that yet. Try one of these instead:",
      source: "fallback",
      tokensUsed: 0,
      conversationId: "c1",
      messageId: "m1",
      fallbackChips: ["briefing", "what is on my calendar today", "create task to <thing>"],
    });

    const InstinctChat = await importComponent();
    await act(async () => {
      render(<InstinctChat showHistory={false} />);
    });
    await typeAndSend("asdfgh quantum dolphin");

    await waitFor(() => {
      expect(screen.getByTestId("assistant-fallback-chips")).toBeInTheDocument();
    });
    expect(screen.getByText("briefing")).toBeInTheDocument();
    expect(screen.getByText("what is on my calendar today")).toBeInTheDocument();
    expect(screen.getByText(/create task to/)).toBeInTheDocument();
  });

  test("clicking a fallback chip fills the composer + fires analytics", async () => {
    mockApi({
      response: "I'm not sure how to help with that yet. Try one of these instead:",
      source: "fallback",
      tokensUsed: 0,
      conversationId: "c1",
      messageId: "m1",
      workflowId: "wf-99",
      fallbackChips: ["briefing", "what is on my calendar today"],
    });

    const InstinctChat = await importComponent();
    await act(async () => {
      render(<InstinctChat showHistory={false} />);
    });
    await typeAndSend("zzz qqq");

    await waitFor(() => {
      expect(screen.getByTestId("assistant-fallback-chips")).toBeInTheDocument();
    });

    fetchMock.mockClear();
    await act(async () => {
      fireEvent.click(screen.getByText("briefing"));
    });

    /* Composer filled with the chip's prompt. */
    const textarea = (await screen.findByTestId("assistant-composer-input")) as HTMLTextAreaElement;
    expect(textarea.value).toBe("briefing");

    /* Analytics fired with workflow_id from the originating turn. */
    const analyticsCall = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes("/api/analytics"),
    );
    expect(analyticsCall).toBeDefined();
    const body = JSON.parse(String(analyticsCall![1]?.body ?? "{}"));
    expect(body.event).toBe("assistant.fallback_chip_clicked");
    expect(body.metadata.prompt).toBe("briefing");
    expect(body.metadata.workflow_id).toBe("wf-99");
  });
});

describe("InstinctChat — fallback chips ABSENT on normal responses", () => {
  test("response without fallbackChips → no chip row rendered", async () => {
    mockApi({
      response: "Found 3 PRs in `wolfpack-apex`.",
      source: "tool",
      tokensUsed: 0,
      conversationId: "c1",
      messageId: "m1",
      /* No fallbackChips field. */
    });

    const InstinctChat = await importComponent();
    await act(async () => {
      render(<InstinctChat showHistory={false} />);
    });
    await typeAndSend("what PRs are open");

    await waitFor(() => {
      expect(screen.getByText(/Found 3 PRs/)).toBeInTheDocument();
    });
    expect(screen.queryByTestId("assistant-fallback-chips")).not.toBeInTheDocument();
  });

  test("response with an EMPTY fallbackChips array → still no chip row", async () => {
    mockApi({
      response: "Answer text.",
      source: "tool",
      tokensUsed: 0,
      conversationId: "c1",
      messageId: "m1",
      fallbackChips: [],
    });

    const InstinctChat = await importComponent();
    await act(async () => {
      render(<InstinctChat showHistory={false} />);
    });
    await typeAndSend("query");

    await waitFor(() => {
      expect(screen.getByText("Answer text.")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("assistant-fallback-chips")).not.toBeInTheDocument();
  });
});
