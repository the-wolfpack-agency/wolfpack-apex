/**
 * @jest-environment jsdom
 *
 * USER SIMULATION: a client asks a document question, and the answer must
 * render attractively — a clean clickable source, never a raw percent-encoded
 * URL.
 *
 * This is the test that was missing when the raw-URL sources reached a
 * screenshot in production (#672/#674). It drives the REAL InstinctChat, sends
 * a prompt the way a user does, returns the EXACT production response shape for
 * "what is in the SOW?" (the citation lives only in the appendCitations text
 * footer, with NO structured sources — the case the first fix missed), and
 * asserts what the client actually sees:
 *   - a clean, readable document title (not the raw filename, not the URL),
 *   - that title is a link to the document,
 *   - the giant percent-encoded URL is NOT visible anywhere,
 *   - and the model/token badge (a deliberate feature) is still shown.
 */

import "fake-indexeddb/auto";
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const fetchMock = jest.fn();

const SHAREPOINT_URL =
  "https://netorg9503444.sharepoint.com/sites/WolfpackxPCNA/Shared%20Documents/General/viaPeople%20Work%20Order.docx.pdf";

/** The exact shape the backend returns for the SOW answer: citation only in the
 *  text footer, no structured sources array. */
const SOW_PAYLOAD = {
  response:
    "The Statement of Work includes Payment Terms: 50% due within 30 days of " +
    "execution of the Work Order. [1]\n\n**Sources:**\n" +
    `1. [viaPeople Work Order_Wolfpack Agency_360 Feedback_5-7-25[36].docx.pdf](${SHAREPOINT_URL})`,
  source: "ai",
  model: "gpt-4o-mini",
  tokensUsed: 2338,
  conversationId: "c1",
  messageId: "m1",
  // NOTE: no `sources` — this is what made the raw URL survive before.
};

beforeAll(() => {
  global.fetch = fetchMock as unknown as typeof fetch;
  if (!(Element.prototype as unknown as { scrollIntoView?: () => void }).scrollIntoView) {
    (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => undefined;
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
  fetchMock.mockImplementation((input: RequestInfo, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    const method = init?.method ?? "GET";
    const ok = (payload: unknown) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(payload),
        text: () => Promise.resolve(JSON.stringify(payload)),
      } as unknown as Response);
    if (url.includes("/api/assistant") && url.includes("conversations=true")) return ok({ conversations: [] });
    if (url.includes("/api/assistant") && method === "POST") return ok(SOW_PAYLOAD);
    return ok({});
  });
});

async function importComponent() {
  const mod = await import("@/components/InstinctChat");
  return mod.default;
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

describe("assistant answer renders sources attractively for the client", () => {
  it("shows a clean clickable document title, not the raw URL", async () => {
    const InstinctChat = await importComponent();
    await act(async () => {
      render(<InstinctChat showHistory={false} />);
    });

    await typeAndSend("what is in the SOW?");

    // The clean source card appears.
    const cards = await screen.findByTestId("assistant-source-cards", undefined, { timeout: 10_000 });
    // Readable title — underscores gone, extension gone, [36] gone.
    expect(within(cards).getByText(/viaPeople Work Order Wolfpack Agency 360 Feedback 5-7-25/)).toBeInTheDocument();
    // It links to the actual document.
    const link = within(cards).getByRole("link");
    expect(link).toHaveAttribute("href", SHAREPOINT_URL);

    // The giant percent-encoded URL is NOT shown as visible text anywhere.
    expect(screen.queryByText(/Shared%20Documents/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\*\*Sources:\*\*/)).not.toBeInTheDocument();
  });

  it("keeps the model/token badge (a deliberate client-facing feature)", async () => {
    const InstinctChat = await importComponent();
    await act(async () => {
      render(<InstinctChat showHistory={false} />);
    });
    await typeAndSend("what is in the SOW?");
    await screen.findByTestId("assistant-source-cards", undefined, { timeout: 10_000 });
    // Model name still surfaced to the client.
    expect(screen.getByText(/gpt-4o-mini/)).toBeInTheDocument();
  });
});
