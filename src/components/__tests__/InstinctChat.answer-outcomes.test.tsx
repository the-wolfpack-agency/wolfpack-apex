/**
 * @jest-environment jsdom
 *
 * What the person did with the answer, which nothing recorded.
 *
 * THE GAP. The product emits 133 assistant events and every one describes what
 * the SYSTEM did: which tool ran, what it retrieved, what it refused, what it
 * cost. Not one described what the PERSON did in response, and the response is
 * where frustration lives.
 *
 * There was no copy affordance at all, and the only other post-answer signal,
 * assistant.source_viewed, has fired ONCE in the product's life (2026-04-23)
 * carrying nothing but a source_type, so it could not even say which answer
 * was being checked.
 *
 * The cost of that: 99.4% of conversations are one question and no more, and
 * nothing can say whether that is somebody satisfied or somebody giving up.
 *
 * WHAT IS DELIBERATELY NOT RECORDED. The metadata carries the answer's source,
 * its length, whether it had sources, and the workflow id. No content, no
 * selection, no keystrokes, no scroll depth. These events name individuals, so
 * they record THAT somebody acted rather than what they read.
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

/** Analytics posts made during the turn, so a signal can be asserted by name. */
function analyticsEvents(): Array<{ event: string; metadata: Record<string, unknown> }> {
  return fetchMock.mock.calls
    .filter(([url]) => String(url).includes("/api/analytics"))
    .map(([, init]) => {
      try {
        return JSON.parse(String((init as RequestInit)?.body ?? "{}"));
      } catch {
        return {};
      }
    })
    .filter((b) => typeof b?.event === "string");
}

describe("copying an answer", () => {
  beforeEach(() => {
    Object.assign(navigator, { clipboard: { writeText: jest.fn().mockResolvedValue(undefined) } });
  });

  it("offers a copy control on an assistant answer", async () => {
    mockApi({ response: "The payment terms are net 30.", source: "brain" });
    const Chat = await importComponent();
    render(<Chat />);
    await sendMessage("what are the payment terms");
    await waitFor(() => expect(screen.getByTestId("copy-answer-1")).toBeInTheDocument());
  });

  it("puts the answer on the clipboard", async () => {
    mockApi({ response: "The payment terms are net 30.", source: "brain" });
    const Chat = await importComponent();
    render(<Chat />);
    await sendMessage("what are the payment terms");
    const button = await screen.findByTestId("copy-answer-1");
    await act(async () => {
      fireEvent.click(button);
    });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("The payment terms are net 30.");
  });

  /* THE SIGNAL. A copy is the clearest "this was useful" a person gives
     without being asked, and until now it left no trace at all. */
  it("records that an answer was copied, and which kind it was", async () => {
    mockApi({ response: "The payment terms are net 30.", source: "brain" });
    const Chat = await importComponent();
    render(<Chat />);
    await sendMessage("what are the payment terms");
    await act(async () => {
      fireEvent.click(await screen.findByTestId("copy-answer-1"));
    });
    const copied = analyticsEvents().find((e) => e.event === "assistant.answer_copied");
    expect(copied).toBeTruthy();
    expect(copied!.metadata.answer_source).toBe("brain");
  });

  /* THE PRIVACY LINE, ASSERTED. These events name individuals, so they must
     record that somebody acted and never what they read. */
  it("never puts the answer text in the event", async () => {
    mockApi({ response: "Net 30 from invoice date, 2% inside 10 days.", source: "brain" });
    const Chat = await importComponent();
    render(<Chat />);
    await sendMessage("what are the payment terms");
    await act(async () => {
      fireEvent.click(await screen.findByTestId("copy-answer-1"));
    });
    const copied = analyticsEvents().find((e) => e.event === "assistant.answer_copied")!;
    const serialised = JSON.stringify(copied.metadata);
    expect(serialised).not.toContain("Net 30");
    expect(serialised).not.toContain("invoice");
  });

  it("says so on the button, so the click has an answer", async () => {
    mockApi({ response: "Net 30.", source: "brain" });
    const Chat = await importComponent();
    render(<Chat />);
    await sendMessage("terms");
    const button = await screen.findByTestId("copy-answer-1");
    await act(async () => {
      fireEvent.click(button);
    });
    await waitFor(() => expect(screen.getByTestId("copy-answer-1").textContent).toMatch(/copied/i));
  });

  /* An empty answer has nothing to copy, and a control that cannot work must
     not be offered: that is the defect this product tracks on /admin/insights
     under controls shown to roles that cannot use them. */
  it("is not offered on an empty answer", async () => {
    mockApi({ response: "", source: "fallback" });
    const Chat = await importComponent();
    render(<Chat />);
    await sendMessage("anything");
    await waitFor(() => expect(screen.queryByTestId("copy-answer-1")).not.toBeInTheDocument());
  });
});
