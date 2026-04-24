/**
 * @jest-environment jsdom
 *
 * /search page — UI behavior contract.
 *
 * Locks in:
 *   - Renders results from the API mock, grouped by type.
 *   - Filter chips toggle the active set + retrigger the search.
 *   - Clicking a result fires the analytics POST (fire-and-forget).
 */

import "@testing-library/jest-dom";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";

const mockFetch = jest.fn();
const mockReplace = jest.fn();

jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: unknown[]) => mockFetch(...a),
  jsonHeaders: () => ({ "content-type": "application/json" }),
}));

jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mockReplace, push: jest.fn() }),
  useSearchParams: () => new URLSearchParams(""),
}));

import SearchPage from "@/app/(dashboard)/search/page";

// jsdom in this repo doesn't ship a global `Response` constructor —
// craft a minimal stand-in matching the bits page.tsx reads (`ok`,
// `status`, `json()`).
function jsonResponse(body: unknown, status = 200): { ok: boolean; status: number; json: () => Promise<unknown> } {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

const SAMPLE = {
  results: [
    {
      type: "chat",
      id: "chat-1",
      title: "Greenfield retainer",
      snippet: "Greenfield is signing today",
      timestamp: new Date(Date.now() - 60_000).toISOString(),
      url: "/messages?chat=chat-1",
    },
    {
      type: "email",
      id: "mail-1",
      title: "RE: Q2 Retainer",
      snippet: "From James: Legal approved the SOW",
      timestamp: new Date(Date.now() - 3600_000).toISOString(),
      url: "/emails?id=mail-1",
    },
    {
      type: "calendar",
      id: "evt-1",
      title: "Greenfield strategy review",
      snippet: "Teams · with James Greenfield",
      timestamp: new Date(Date.now() + 86_400_000).toISOString(),
      url: "https://outlook.office.com/calendar/item/evt-1",
    },
  ],
  took_ms: 42,
  counts: { chats: 1, channels: 0, emails: 1, calendar: 1, knowledge: 0 },
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  mockFetch.mockResolvedValue(jsonResponse(SAMPLE));
});

afterEach(() => {
  jest.useRealTimers();
});

async function flushDebounce(): Promise<void> {
  await act(async () => {
    jest.advanceTimersByTime(300);
  });
  // Let the awaited fetch microtask resolve.
  await act(async () => {
    await Promise.resolve();
  });
}

describe("/search page", () => {
  it("renders results from the API mock, grouped by type", async () => {
    render(<SearchPage />);

    // Type into the search input to trigger a query.
    const input = screen.getByTestId("search-input");
    fireEvent.change(input, { target: { value: "greenfield" } });
    await flushDebounce();

    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    // First call should be a GET to /api/search with q=greenfield.
    const firstCall = mockFetch.mock.calls[0][0] as string;
    expect(firstCall).toMatch(/^\/api\/search\?/);
    expect(firstCall).toContain("q=greenfield");

    // Each result row renders.
    expect(await screen.findByTestId("result-chat-1")).toBeInTheDocument();
    expect(screen.getByTestId("result-mail-1")).toBeInTheDocument();
    expect(screen.getByTestId("result-evt-1")).toBeInTheDocument();

    // Groups render with the right headings.
    expect(screen.getByTestId("group-chat")).toBeInTheDocument();
    expect(screen.getByTestId("group-email")).toBeInTheDocument();
    expect(screen.getByTestId("group-calendar")).toBeInTheDocument();
  });

  it("filter chips toggle the active set and re-trigger search", async () => {
    render(<SearchPage />);

    const input = screen.getByTestId("search-input");
    fireEvent.change(input, { target: { value: "x" } });
    await flushDebounce();
    const callsBefore = mockFetch.mock.calls.length;

    // Click the Emails chip — should narrow filter to non-default set
    // and trigger a new fetch.
    const emailChip = screen.getByTestId("chip-email");
    fireEvent.click(emailChip);
    await flushDebounce();

    expect(mockFetch.mock.calls.length).toBeGreaterThan(callsBefore);
    // Latest call URL should include `types=` because filter is no
    // longer the default full set.
    const lastCall = mockFetch.mock.calls[mockFetch.mock.calls.length - 1][0] as string;
    expect(lastCall).toContain("types=");
  });

  it("clicking a result fires the analytics POST", async () => {
    render(<SearchPage />);

    const input = screen.getByTestId("search-input");
    fireEvent.change(input, { target: { value: "greenfield" } });
    await flushDebounce();

    const link = await screen.findByTestId("result-chat-1");
    mockFetch.mockClear();
    // Stub the analytics POST so the click finds a response to await.
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));

    fireEvent.click(link);

    // The analytics call goes out synchronously inside the click handler.
    expect(mockFetch).toHaveBeenCalled();
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/analytics");
    expect((init as RequestInit).method).toBe("POST");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.event).toBe("insight.search.result_clicked");
    expect(body.metadata).toEqual(
      expect.objectContaining({
        surface: "search",
        action: "result_clicked",
        target: "chat-1",
        result_type: "chat",
        position: 0,
      }),
    );
  });
});
