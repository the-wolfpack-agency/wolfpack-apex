/**
 * @jest-environment jsdom
 *
 * InstinctChat — composer polish + stop-button contract.
 *
 * Locks the May 18 demo-prep changes:
 *  - Send button swaps to Stop while a generation is in flight.
 *  - Clicking Stop returns the UI to a ready state immediately AND
 *    drops the in-flight assistant message rather than rendering it
 *    on arrival.
 *  - Composer textarea auto-resizes as the user types.
 *  - Skeleton rows render under the typing dots so the loading state
 *    suggests "structured content on the way" rather than "thinking."
 *  - assistant.generation_stopped analytics fires on stop click.
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

/**
 * Build a fetch impl with a deferred /api/assistant POST so tests can
 * inspect the in-flight UI between request and response.
 */
function mockDeferredApi() {
  let resolveAssistant: ((value: unknown) => void) | null = null;
  const inFlight = new Promise<unknown>((r) => {
    resolveAssistant = r;
  });

  const analyticsEvents: string[] = [];

  fetchMock.mockImplementation((input: RequestInfo, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    const method = init?.method ?? "GET";

    if (url.includes("/api/analytics") && method === "POST") {
      try {
        const body = JSON.parse(String(init?.body ?? "{}"));
        if (body.event) analyticsEvents.push(body.event);
      } catch {
        /* ignore */
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve("{}"),
      } as unknown as Response);
    }

    if (url.includes("/api/assistant") && method === "POST" && !url.includes("conversations=true")) {
      return inFlight.then(
        (payload) =>
          ({
            ok: true,
            status: 200,
            json: () => Promise.resolve(payload),
            text: () => Promise.resolve(JSON.stringify(payload)),
          }) as unknown as Response,
      );
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

  return {
    finish: (payload: Record<string, unknown>) => {
      resolveAssistant?.(payload);
    },
    analyticsEvents,
  };
}

async function typeAndSend(text: string) {
  const textarea = (await screen.findByTestId("assistant-composer-input")) as HTMLTextAreaElement;
  const nativeInputSetter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  await act(async () => {
    nativeInputSetter?.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    fireEvent.click(screen.getByTestId("assistant-send-btn"));
  });
}

describe("InstinctChat composer — stop button swap", () => {
  test("Send button renders when idle and swaps to Stop while loading", async () => {
    const api = mockDeferredApi();
    const InstinctChat = await importComponent();
    await act(async () => {
      render(<InstinctChat showHistory={false} />);
    });

    /* Idle state: Send visible, Stop absent. */
    expect(screen.getByTestId("assistant-send-btn")).toBeInTheDocument();
    expect(screen.queryByTestId("assistant-stop-btn")).not.toBeInTheDocument();

    await typeAndSend("hello");

    /* In-flight state: Stop visible, Send swapped out. */
    await waitFor(() => {
      expect(screen.getByTestId("assistant-stop-btn")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("assistant-send-btn")).not.toBeInTheDocument();

    /* Skeleton + typing dots both rendered while in flight. */
    expect(screen.getByTestId("assistant-typing-indicator")).toBeInTheDocument();
    expect(screen.getByTestId("assistant-skeleton-row-1")).toBeInTheDocument();
    expect(screen.getByTestId("assistant-skeleton-row-2")).toBeInTheDocument();

    /* Finish the request so the test cleans up. */
    api.finish({
      response: "Hi.",
      source: "tool",
      tokensUsed: 0,
      conversationId: "c1",
      messageId: "m1",
    });
    await waitFor(() => {
      expect(screen.getByTestId("assistant-send-btn")).toBeInTheDocument();
    });
  });
});

describe("InstinctChat composer — Stop click drops late response", () => {
  test("clicking Stop mid-flight returns UI to ready and ignores arriving payload", async () => {
    const api = mockDeferredApi();
    const InstinctChat = await importComponent();
    await act(async () => {
      render(<InstinctChat showHistory={false} />);
    });

    await typeAndSend("slow query");

    await waitFor(() => {
      expect(screen.getByTestId("assistant-stop-btn")).toBeInTheDocument();
    });

    /* User bails. */
    await act(async () => {
      fireEvent.click(screen.getByTestId("assistant-stop-btn"));
    });

    /* Send returns immediately; Stop gone. */
    await waitFor(() => {
      expect(screen.getByTestId("assistant-send-btn")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("assistant-stop-btn")).not.toBeInTheDocument();

    /* Now resolve the deferred /api/assistant — its payload should be
     * silently dropped, not rendered as an assistant bubble. */
    await act(async () => {
      api.finish({
        response: "This shouldn't appear.",
        source: "tool",
        tokensUsed: 0,
        conversationId: "c1",
        messageId: "m1",
      });
      /* Microtasks flush. */
      await Promise.resolve();
    });

    expect(screen.queryByText("This shouldn't appear.")).not.toBeInTheDocument();
  });

  test("clicking Stop fires assistant.generation_stopped analytics", async () => {
    const api = mockDeferredApi();
    const InstinctChat = await importComponent();
    await act(async () => {
      render(<InstinctChat showHistory={false} />);
    });

    await typeAndSend("slow");
    await waitFor(() => {
      expect(screen.getByTestId("assistant-stop-btn")).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("assistant-stop-btn"));
    });

    await waitFor(() => {
      expect(api.analyticsEvents).toContain("assistant.generation_stopped");
    });

    /* Drain so cleanup is clean. */
    api.finish({
      response: "x",
      source: "tool",
      tokensUsed: 0,
      conversationId: "c1",
      messageId: "m1",
    });
  });
});

describe("InstinctChat composer — auto-resize textarea", () => {
  test("textarea height grows as content adds lines", async () => {
    mockDeferredApi();
    const InstinctChat = await importComponent();
    await act(async () => {
      render(<InstinctChat showHistory={false} />);
    });

    const textarea = (await screen.findByTestId(
      "assistant-composer-input",
    )) as HTMLTextAreaElement;

    /* jsdom doesn't compute real layout, so scrollHeight is mocked
     * via the getter override. The effect under test sets style.height
     * to min(scrollHeight, 120). We assert the effect ran by checking
     * that style.height was assigned a px value after typing. */
    Object.defineProperty(textarea, "scrollHeight", {
      configurable: true,
      get: () => 88,
    });

    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    await act(async () => {
      setter?.call(textarea, "line 1\nline 2\nline 3");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(textarea.style.height).toBe("88px");
  });

  test("auto-resize floor is 46px so the empty composer doesn't collapse below the send button", async () => {
    mockDeferredApi();
    const InstinctChat = await importComponent();
    await act(async () => {
      render(<InstinctChat showHistory={false} />);
    });

    const textarea = (await screen.findByTestId(
      "assistant-composer-input",
    )) as HTMLTextAreaElement;

    /* Empty textarea — scrollHeight tiny (24px is the rendered
     * line-height in jsdom). The clamp should floor to 46. */
    Object.defineProperty(textarea, "scrollHeight", {
      configurable: true,
      get: () => 24,
    });

    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    await act(async () => {
      setter?.call(textarea, "");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(textarea.style.height).toBe("46px");
  });

  test("auto-resize caps at the 120px maxHeight even when content overflows", async () => {
    mockDeferredApi();
    const InstinctChat = await importComponent();
    await act(async () => {
      render(<InstinctChat showHistory={false} />);
    });

    const textarea = (await screen.findByTestId(
      "assistant-composer-input",
    )) as HTMLTextAreaElement;

    Object.defineProperty(textarea, "scrollHeight", {
      configurable: true,
      get: () => 500,
    });

    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    await act(async () => {
      setter?.call(textarea, "x\n".repeat(30));
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });

    /* Cap is min(scrollHeight, 120) → 120 even with a 500px scrollHeight. */
    expect(textarea.style.height).toBe("120px");
  });
});

describe("InstinctChat composer — focus-glow class wired", () => {
  test("textarea carries wp-input-focus class for the CSS focus halo", async () => {
    mockDeferredApi();
    const InstinctChat = await importComponent();
    await act(async () => {
      render(<InstinctChat showHistory={false} />);
    });

    const textarea = await screen.findByTestId("assistant-composer-input");
    expect(textarea.className).toMatch(/\bwp-input-focus\b/);
  });
});
