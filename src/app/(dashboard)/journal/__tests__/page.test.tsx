/** @jest-environment jsdom */
 
import "@testing-library/jest-dom";

const mockFetchWithRefresh = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: any[]) => mockFetchWithRefresh(...a),
  authHeaders: () => ({ Authorization: "Bearer x" }),
  jsonHeaders: () => ({ "Content-Type": "application/json", Authorization: "Bearer x" }),
}));

jest.mock("@/lib/journals-offline", () => ({
  saveJournalEntryOffline: jest.fn().mockResolvedValue({ status: "created" }),
}));

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import JournalPage, { groupEventsByDay } from "@/app/(dashboard)/journal/page";

function isoOffset(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(10, 30, 0, 0);
  return d.toISOString();
}

function mockJournal(events: Array<{ event_type: string; timestamp: string; metadata?: any }>) {
  mockFetchWithRefresh.mockImplementation((url: string) => {
    if (typeof url === "string" && url.startsWith("/api/journal")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          journal: {
            id: "j-1",
            user_id: "u-1",
            date: new Date().toISOString().slice(0, 10),
            content: "",
            auto_context: { events },
            mood: null,
            highlights: [],
            blockers: [],
          },
        }),
      });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
  });
}

beforeEach(() => {
  mockFetchWithRefresh.mockReset();
  try {
    window.localStorage.clear();
  } catch {
    /* noop */
  }
});

describe("groupEventsByDay", () => {
  test("groups events by their ISO date and sorts newest-first", () => {
    const groups = groupEventsByDay([
      { time: "10:00", timestampIso: "2026-04-21T10:00:00Z", description: "a", type: "t" },
      { time: "11:00", timestampIso: "2026-04-23T11:00:00Z", description: "b", type: "t" },
      { time: "12:00", timestampIso: "2026-04-21T12:00:00Z", description: "c", type: "t" },
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0].date).toBe("2026-04-23");
    expect(groups[1].items.map((i) => i.description)).toEqual(["a", "c"]);
  });
});

describe("JournalPage", () => {
  test("renders with HTTP 200 and shows density toggle + day groups", async () => {
    mockJournal([
      { event_type: "knowledge.question_asked", timestamp: isoOffset(0), metadata: { question: "live q" } },
      { event_type: "knowledge.question_asked", timestamp: isoOffset(2), metadata: { question: "old q" } },
    ]);
    await act(async () => {
      render(<JournalPage />);
    });
    await waitFor(() => expect(screen.getByTestId("journal-page")).toBeInTheDocument());

    // Verify the API returned 200 (not a 500) — captured in the mock.
    const journalCall = mockFetchWithRefresh.mock.calls.find((c) =>
      typeof c[0] === "string" && (c[0] as string).startsWith("/api/journal"),
    );
    expect(journalCall).toBeTruthy();

    // Density toggle present with both options.
    expect(screen.getByTestId("journal-density-toggle")).toBeInTheDocument();
    expect(screen.getByTestId("journal-density-compact")).toBeInTheDocument();
    expect(screen.getByTestId("journal-density-comfortable")).toBeInTheDocument();

    // Two day groups rendered.
    //
    // The expected key comes from the SAME helper that built the fixture, not
    // from the clock. isoOffset sets a LOCAL 10:30 and then serialises to UTC,
    // so in any timezone behind UTC the fixture's newest event lands on the
    // previous UTC day for the last few hours of local time — and an assertion
    // built from `new Date().toISOString()` looks for a group that does not
    // exist. It failed at 00:11 UTC on 2026-08-02 for exactly that reason, and
    // would have failed CI in the same window every day.
    const todayKey = isoOffset(0).slice(0, 10);
    expect(screen.getByTestId(`journal-day-${todayKey}`)).toBeInTheDocument();
  });

  test("default-collapses days older than today + emits group_collapsed when toggled", async () => {
    const older = isoOffset(3);
    mockJournal([
      { event_type: "system.login", timestamp: isoOffset(0) },
      { event_type: "knowledge.question_asked", timestamp: older, metadata: { question: "old q" } },
    ]);
    await act(async () => {
      render(<JournalPage />);
    });
    await waitFor(() => expect(screen.getByTestId("journal-page")).toBeInTheDocument());

    const olderKey = older.slice(0, 10);
    const toggle = screen.getByTestId(`journal-day-toggle-${olderKey}`);
    // Collapsed by default → aria-expanded=false → "Show" label visible.
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    await act(async () => {
      fireEvent.click(toggle);
    });
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    const analyticsCalls = mockFetchWithRefresh.mock.calls
      .filter((c) => c[0] === "/api/analytics")
      .map((c) => JSON.parse(c[1].body));
    expect(analyticsCalls.some((p) => p.event === "journal.group_collapsed")).toBe(true);
  });

  test("density toggle persists to localStorage + fires density_toggled analytics", async () => {
    mockJournal([{ event_type: "system.login", timestamp: isoOffset(0) }]);
    await act(async () => {
      render(<JournalPage />);
    });
    await waitFor(() => expect(screen.getByTestId("journal-page")).toBeInTheDocument());

    await act(async () => {
      fireEvent.click(screen.getByTestId("journal-density-compact"));
    });

    expect(window.localStorage.getItem("instinct_journal_density")).toBe("compact");
    expect(screen.getByTestId("journal-page")).toHaveAttribute("data-density", "compact");

    const analyticsCalls = mockFetchWithRefresh.mock.calls
      .filter((c) => c[0] === "/api/analytics")
      .map((c) => JSON.parse(c[1].body));
    expect(analyticsCalls.some((p) => p.event === "journal.density_toggled" && p.metadata.density === "compact")).toBe(
      true,
    );
  });

  test("paginates with Load more so the DOM stays bounded on heavy days", async () => {
    const events = Array.from({ length: 120 }, (_, i) => ({
      event_type: "knowledge.question_asked",
      timestamp: isoOffset(0),
      metadata: { question: `q${i}` },
    }));
    mockJournal(events);
    await act(async () => {
      render(<JournalPage />);
    });
    await waitFor(() => expect(screen.getByTestId("journal-page")).toBeInTheDocument());

    // 120 > 50 → Load more must be present.
    expect(screen.getByTestId("journal-load-more")).toBeInTheDocument();
  });
});
