/**
 * @jest-environment jsdom
 *
 * SearchResultsWidget — DOM render + checkbox filter + refresh +
 * analytics + empty-results path.
 *
 * Locks in:
 *   - Header counts + per-source checkboxes appear only for sources
 *     with > 0 hits.
 *   - Toggling a checkbox filters the visible rows client-side
 *     (no refetch).
 *   - Toggling fires assistant.widget_interaction with
 *     { action: "toggle_source", value: <source> }.
 *   - "Search again" fires assistant.search_refilter_requested
 *     carrying the narrowed types list.
 *   - Empty-results path renders the inline empty state (no
 *     checkboxes, no refresh button).
 *   - widget_rendered fires once on mount.
 */

import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";

const mockFetch = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: unknown[]) => mockFetch(...a),
  jsonHeaders: () => ({ "Content-Type": "application/json" }),
}));

import { SearchResultsWidget } from "@/components/widgets/SearchResultsWidget";
import type { SearchResultsWidgetSpec } from "@/lib/assistant/widgets/types";

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
});

const populatedSpec: SearchResultsWidgetSpec = {
  kind: "search_results",
  query: "porsche",
  took_ms: 87,
  counts: { chats: 2, channels: 0, emails: 1, calendar: 1, knowledge: 0, crm: 0 },
  results: [
    {
      type: "chat",
      id: "c1",
      title: "Porsche chat 1",
      snippet: "Hey did you see the 911 turbo?",
      timestamp: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      url: "/messages?chat=c1",
    },
    {
      type: "chat",
      id: "c2",
      title: "Porsche chat 2",
      snippet: "Following up on the Cayenne",
      timestamp: new Date(Date.now() - 90 * 60 * 1000).toISOString(),
      url: "/messages?chat=c2",
    },
    {
      type: "email",
      id: "e1",
      title: "RE: Porsche launch",
      snippet: "Quarterly review meeting",
      timestamp: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      url: "https://outlook.test/e1",
    },
    {
      type: "calendar",
      id: "evt1",
      title: "Porsche test drive",
      snippet: "10am Friday",
      timestamp: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
      url: "/calendar?event=evt1",
    },
  ],
};

describe("SearchResultsWidget — populated", () => {
  test("renders the widget container + result-count meta line", () => {
    render(<SearchResultsWidget spec={populatedSpec} />);
    expect(screen.getByTestId("search-results-widget")).toBeInTheDocument();
    expect(screen.getByText(/4 results in 87ms for/)).toBeInTheDocument();
  });

  test("only renders checkboxes for sources with counts > 0", () => {
    render(<SearchResultsWidget spec={populatedSpec} />);
    /* chats / emails / calendar are non-zero → checkboxes present. */
    expect(screen.getByTestId("search-results-filter-chat")).toBeInTheDocument();
    expect(screen.getByTestId("search-results-filter-email")).toBeInTheDocument();
    expect(screen.getByTestId("search-results-filter-calendar")).toBeInTheDocument();
    /* channels / knowledge / crm are zero → no checkbox row. */
    expect(screen.queryByTestId("search-results-filter-channel")).toBeNull();
    expect(screen.queryByTestId("search-results-filter-knowledge")).toBeNull();
    expect(screen.queryByTestId("search-results-filter-crm")).toBeNull();
  });

  test("all available source checkboxes start checked", () => {
    render(<SearchResultsWidget spec={populatedSpec} />);
    const chat = screen.getByTestId("search-results-filter-input-chat") as HTMLInputElement;
    const email = screen.getByTestId("search-results-filter-input-email") as HTMLInputElement;
    const cal = screen.getByTestId("search-results-filter-input-calendar") as HTMLInputElement;
    expect(chat.checked).toBe(true);
    expect(email.checked).toBe(true);
    expect(cal.checked).toBe(true);
  });

  test("all results render with their source-type badge", () => {
    render(<SearchResultsWidget spec={populatedSpec} />);
    expect(screen.getByTestId("search-results-row-chat-c1")).toBeInTheDocument();
    expect(screen.getByTestId("search-results-row-chat-c2")).toBeInTheDocument();
    expect(screen.getByTestId("search-results-row-email-e1")).toBeInTheDocument();
    expect(screen.getByTestId("search-results-row-calendar-evt1")).toBeInTheDocument();
    /* At least one badge per type rendered. */
    expect(screen.getAllByTestId("search-results-badge-chat").length).toBeGreaterThan(0);
  });

  test("unchecking a source filters its rows from the visible list", () => {
    render(<SearchResultsWidget spec={populatedSpec} />);
    const chat = screen.getByTestId("search-results-filter-input-chat") as HTMLInputElement;
    fireEvent.click(chat);
    /* Chat rows gone, email + calendar remain. */
    expect(screen.queryByTestId("search-results-row-chat-c1")).toBeNull();
    expect(screen.queryByTestId("search-results-row-chat-c2")).toBeNull();
    expect(screen.getByTestId("search-results-row-email-e1")).toBeInTheDocument();
    expect(screen.getByTestId("search-results-row-calendar-evt1")).toBeInTheDocument();
  });

  test("toggling a source fires widget_interaction with action=toggle_source + value=<source>", () => {
    render(<SearchResultsWidget spec={populatedSpec} />);
    mockFetch.mockClear();
    fireEvent.click(screen.getByTestId("search-results-filter-input-email"));
    const call = mockFetch.mock.calls.find((c) => {
      const body = String(c[1]?.body || "");
      return body.includes("widget_interaction") && body.includes("toggle_source");
    });
    expect(call).toBeDefined();
    const body = JSON.parse(String(call?.[1]?.body || "{}"));
    expect(body.metadata.widget_kind).toBe("search_results");
    expect(body.metadata.action).toBe("toggle_source");
    expect(body.metadata.value).toBe("email");
  });

  test("'Search again' fires assistant.search_refilter_requested with the narrowed types", () => {
    render(<SearchResultsWidget spec={populatedSpec} />);
    /* Uncheck email + calendar so the request is narrowed to chat only. */
    fireEvent.click(screen.getByTestId("search-results-filter-input-email"));
    fireEvent.click(screen.getByTestId("search-results-filter-input-calendar"));
    mockFetch.mockClear();
    fireEvent.click(screen.getByTestId("search-results-refresh"));
    const call = mockFetch.mock.calls.find((c) =>
      String(c[1]?.body || "").includes("search_refilter_requested"),
    );
    expect(call).toBeDefined();
    const body = JSON.parse(String(call?.[1]?.body || "{}"));
    expect(body.event).toBe("assistant.search_refilter_requested");
    expect(body.metadata.query).toBe("porsche");
    expect(body.metadata.types).toBe("chat");
  });

  test("unchecking every box snaps back to all available (no empty filter state)", () => {
    render(<SearchResultsWidget spec={populatedSpec} />);
    /* Three available sources — uncheck all three. The third toggle
     *  should reset the set to all available (matches the page surface). */
    fireEvent.click(screen.getByTestId("search-results-filter-input-chat"));
    fireEvent.click(screen.getByTestId("search-results-filter-input-email"));
    fireEvent.click(screen.getByTestId("search-results-filter-input-calendar"));
    const chat = screen.getByTestId("search-results-filter-input-chat") as HTMLInputElement;
    const email = screen.getByTestId("search-results-filter-input-email") as HTMLInputElement;
    const cal = screen.getByTestId("search-results-filter-input-calendar") as HTMLInputElement;
    expect(chat.checked).toBe(true);
    expect(email.checked).toBe(true);
    expect(cal.checked).toBe(true);
  });

  test("fires widget_rendered on mount with result + source counts", () => {
    render(<SearchResultsWidget spec={populatedSpec} />);
    const call = mockFetch.mock.calls.find((c) =>
      String(c[1]?.body || "").includes("assistant.widget_rendered"),
    );
    expect(call).toBeDefined();
    const body = JSON.parse(String(call?.[1]?.body || "{}"));
    expect(body.metadata.widget_kind).toBe("search_results");
    expect(body.metadata.result_count).toBe(4);
    expect(body.metadata.source_count).toBe(3);
  });

  test("workflowId is threaded into every analytics payload when present", () => {
    render(<SearchResultsWidget spec={populatedSpec} workflowId="wf-xyz" />);
    fireEvent.click(screen.getByTestId("search-results-filter-input-chat"));
    const renderedCall = mockFetch.mock.calls.find((c) =>
      String(c[1]?.body || "").includes("assistant.widget_rendered"),
    );
    const interactionCall = mockFetch.mock.calls.find((c) =>
      String(c[1]?.body || "").includes("toggle_source"),
    );
    expect(JSON.parse(String(renderedCall?.[1]?.body || "{}")).metadata.workflow_id).toBe("wf-xyz");
    expect(JSON.parse(String(interactionCall?.[1]?.body || "{}")).metadata.workflow_id).toBe("wf-xyz");
  });
});

describe("SearchResultsWidget — empty results", () => {
  const emptySpec: SearchResultsWidgetSpec = {
    kind: "search_results",
    query: "xyznotfound",
    took_ms: 4,
    counts: { chats: 0, channels: 0, emails: 0, calendar: 0, knowledge: 0, crm: 0 },
    results: [],
  };

  test("renders the empty-state message, no checkbox row, no refresh button", () => {
    render(<SearchResultsWidget spec={emptySpec} />);
    expect(screen.getByTestId("search-results-widget")).toBeInTheDocument();
    expect(screen.getByTestId("search-results-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("search-results-filters")).toBeNull();
    expect(screen.queryByTestId("search-results-refresh")).toBeNull();
  });

  test("widget_rendered still fires on empty mount", () => {
    render(<SearchResultsWidget spec={emptySpec} />);
    const call = mockFetch.mock.calls.find((c) =>
      String(c[1]?.body || "").includes("assistant.widget_rendered"),
    );
    expect(call).toBeDefined();
    const body = JSON.parse(String(call?.[1]?.body || "{}"));
    expect(body.metadata.result_count).toBe(0);
    expect(body.metadata.source_count).toBe(0);
  });
});
