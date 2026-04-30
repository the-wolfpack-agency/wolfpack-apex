/** @jest-environment jsdom */
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Resize handle behaviour:
 *   - Default inbox width is INBOX_WIDTH_DEFAULT (340).
 *   - Drag (mousedown → mousemove → mouseup) updates the column width.
 *   - The chosen width is persisted to localStorage on mouseup.
 *   - On reload, the saved width is honoured.
 *   - Width is clamped between INBOX_WIDTH_MIN (280) and INBOX_WIDTH_MAX (720).
 *   - When the composer opens, the inbox auto-collapses to MIN.
 *   - When the composer closes, the saved width is restored.
 */
import "@testing-library/jest-dom";

const mockFetchWithRefresh = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: any[]) => mockFetchWithRefresh(...a),
  authHeaders: () => ({ Authorization: "Bearer x" }),
  jsonHeaders: () => ({ "Content-Type": "application/json", Authorization: "Bearer x" }),
  getInstinctUser: () => ({ id: "u-me", role: "ceo", email: "me@x", name: "Tester" }),
}));

jest.mock("@/lib/insights/emit", () => ({
  emitInsight: () => {},
}));

import { act, fireEvent, render, screen } from "@testing-library/react";
import EmailsPage, {
  INBOX_WIDTH_DEFAULT,
  INBOX_WIDTH_MIN,
  INBOX_WIDTH_MAX,
  INBOX_WIDTH_KEY,
  clampInboxWidth,
} from "@/app/(dashboard)/emails/page";

interface MockResponse {
  ok?: boolean;
  status?: number;
  json: () => Promise<any>;
}
function ok(body: any, status = 200): MockResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function defaultRouter(url: string): MockResponse {
  if (url.startsWith("/api/email-signatures"))
    return ok({ signatures: [] });
  if (url.startsWith("/api/emails/inbox"))
    return ok({ messages: [], nextSkip: null, unreadCount: 0 });
  if (url.startsWith("/api/emails")) return ok({ templates: [] });
  if (url.startsWith("/api/microsoft?action=emails-from"))
    return ok({ emails: [] });
  if (url.startsWith("/api/calendar/range")) return ok({ events: [] });
  return ok({});
}

beforeEach(() => {
  mockFetchWithRefresh.mockReset();
  mockFetchWithRefresh.mockImplementation((url: string) =>
    Promise.resolve(defaultRouter(url)),
  );
  window.sessionStorage.clear();
  window.localStorage.clear();
  try {
    window.history.replaceState({}, "", "/emails");
  } catch {
    /* noop */
  }
  if (typeof (document as any).execCommand !== "function") {
    (document as any).execCommand = () => true;
  }
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: 1400,
  });
});

async function flushPromises() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 60));
  });
}

// ---------------------------------------------------------------------------
// clampInboxWidth (pure)
// ---------------------------------------------------------------------------

describe("clampInboxWidth", () => {
  test("clamps below MIN to MIN", () => {
    expect(clampInboxWidth(100)).toBe(INBOX_WIDTH_MIN);
  });
  test("clamps above MAX to MAX", () => {
    expect(clampInboxWidth(9999)).toBe(INBOX_WIDTH_MAX);
  });
  test("rounds non-integers", () => {
    expect(clampInboxWidth(420.7)).toBe(421);
  });
  test("returns DEFAULT for non-finite", () => {
    expect(clampInboxWidth(NaN)).toBe(INBOX_WIDTH_DEFAULT);
  });
});

// ---------------------------------------------------------------------------
// Initial render
// ---------------------------------------------------------------------------

describe("Inbox column width", () => {
  it("initial width is DEFAULT when no localStorage value exists", async () => {
    render(<EmailsPage />);
    await flushPromises();
    const col = screen.getByTestId("inbox-column");
    expect(col.getAttribute("data-width")).toBe(String(INBOX_WIDTH_DEFAULT));
  });

  it("respects saved localStorage width on mount", async () => {
    window.localStorage.setItem(INBOX_WIDTH_KEY, "500");
    render(<EmailsPage />);
    await flushPromises();
    const col = screen.getByTestId("inbox-column");
    expect(col.getAttribute("data-width")).toBe("500");
  });

  it("clamps an absurd saved width to MAX", async () => {
    window.localStorage.setItem(INBOX_WIDTH_KEY, "9999");
    render(<EmailsPage />);
    await flushPromises();
    const col = screen.getByTestId("inbox-column");
    expect(col.getAttribute("data-width")).toBe(String(INBOX_WIDTH_MAX));
  });
});

// ---------------------------------------------------------------------------
// Drag → resize → persist
// ---------------------------------------------------------------------------

describe("Resize handle drag", () => {
  it("renders the drag handle on a wide viewport when no compose is open", async () => {
    render(<EmailsPage />);
    await flushPromises();
    expect(screen.getByTestId("emails-resize-handle")).toBeInTheDocument();
  });

  it("drag updates the column width live", async () => {
    render(<EmailsPage />);
    await flushPromises();
    const handle = screen.getByTestId("emails-resize-handle");

    /* mousedown at clientX=400, mousemove +60 → expect width 340 + 60 = 400. */
    fireEvent.mouseDown(handle, { clientX: 400 });
    await act(async () => {
      window.dispatchEvent(new MouseEvent("mousemove", { clientX: 460 }));
    });
    const col = screen.getByTestId("inbox-column");
    expect(col.getAttribute("data-width")).toBe("400");

    await act(async () => {
      window.dispatchEvent(new MouseEvent("mouseup"));
    });
  });

  it("persists the chosen width to localStorage on mouseup", async () => {
    render(<EmailsPage />);
    await flushPromises();
    const handle = screen.getByTestId("emails-resize-handle");
    fireEvent.mouseDown(handle, { clientX: 400 });
    await act(async () => {
      window.dispatchEvent(new MouseEvent("mousemove", { clientX: 500 }));
      window.dispatchEvent(new MouseEvent("mouseup"));
    });
    expect(window.localStorage.getItem(INBOX_WIDTH_KEY)).toBe("440");
  });

  it("clamps drag to MIN", async () => {
    render(<EmailsPage />);
    await flushPromises();
    const handle = screen.getByTestId("emails-resize-handle");
    /* startWidth=340, dragging far left should land at MIN. */
    fireEvent.mouseDown(handle, { clientX: 400 });
    await act(async () => {
      window.dispatchEvent(new MouseEvent("mousemove", { clientX: -1000 }));
      window.dispatchEvent(new MouseEvent("mouseup"));
    });
    const col = screen.getByTestId("inbox-column");
    expect(col.getAttribute("data-width")).toBe(String(INBOX_WIDTH_MIN));
    expect(window.localStorage.getItem(INBOX_WIDTH_KEY)).toBe(
      String(INBOX_WIDTH_MIN),
    );
  });

  it("clamps drag to MAX", async () => {
    render(<EmailsPage />);
    await flushPromises();
    const handle = screen.getByTestId("emails-resize-handle");
    fireEvent.mouseDown(handle, { clientX: 400 });
    await act(async () => {
      window.dispatchEvent(new MouseEvent("mousemove", { clientX: 100000 }));
      window.dispatchEvent(new MouseEvent("mouseup"));
    });
    const col = screen.getByTestId("inbox-column");
    expect(col.getAttribute("data-width")).toBe(String(INBOX_WIDTH_MAX));
  });

  it("ArrowRight on the keyboard nudges width by 16 and persists", async () => {
    render(<EmailsPage />);
    await flushPromises();
    const handle = screen.getByTestId("emails-resize-handle");
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    const col = screen.getByTestId("inbox-column");
    expect(col.getAttribute("data-width")).toBe(
      String(INBOX_WIDTH_DEFAULT + 16),
    );
    expect(window.localStorage.getItem(INBOX_WIDTH_KEY)).toBe(
      String(INBOX_WIDTH_DEFAULT + 16),
    );
  });
});

// ---------------------------------------------------------------------------
// Auto-collapse on compose
// ---------------------------------------------------------------------------

describe("Compose auto-collapse", () => {
  it("collapses the inbox to MIN when the composer opens, then restores on close", async () => {
    /* Save a large preferred width so the difference is visible. */
    window.localStorage.setItem(INBOX_WIDTH_KEY, "500");
    render(<EmailsPage />);
    await flushPromises();
    const col = screen.getByTestId("inbox-column");
    expect(col.getAttribute("data-width")).toBe("500");

    /* Open the composer. */
    fireEvent.click(await screen.findByTestId("inbox-new-email"));
    await flushPromises();
    expect(col.getAttribute("data-width")).toBe(String(INBOX_WIDTH_MIN));

    /* The drag handle disappears while composing (single-pane focus). */
    expect(screen.queryByTestId("emails-resize-handle")).toBeNull();

    /* Discard returns to empty state — restore saved width. */
    fireEvent.click(screen.getByText("Discard"));
    await flushPromises();
    expect(col.getAttribute("data-width")).toBe("500");
    expect(screen.getByTestId("emails-resize-handle")).toBeInTheDocument();
  });
});
