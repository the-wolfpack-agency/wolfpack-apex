/** @jest-environment jsdom */

import "@testing-library/jest-dom";

/**
 * MorningBriefing timezone threading.
 *
 * Locks the fix for the CEO's combining-days bug: the briefing fetch must carry
 * the browser's IANA timezone so the server computes the calendar window for the
 * user's LOCAL day, not a UTC slice. Also asserts refresh + tz compose.
 */

jest.mock("@/lib/client-auth", () => ({
  getInstinctToken: () => "tok",
  authHeaders: () => ({ Authorization: "Bearer tok" }),
}));

// Stub the inner pre-brief panel so this test focuses on the briefing fetch.
jest.mock("@/components/MeetingPreBriefPanel", () => {
  return function StubPanel() {
    return <div data-testid="stub-panel" />;
  };
});

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import MorningBriefing from "@/components/MorningBriefing";

const BRIEFING = {
  generatedAt: "2026-06-23T12:00:00Z",
  greeting: "Good morning, Nick",
  summary: "You have 1 meeting today.",
  calendar: { eventCount: 0, nextEvent: null, events: [] },
  email: { unreadCount: 0, importantEmails: [] },
  financial: {
    cashPosition: 0,
    revenueThisMonth: 0,
    netProfit: 0,
    unpaidInvoiceCount: 0,
    overdueCount: 0,
    recentPayments: [],
  },
  clients: { needingAttention: [] },
  team: { activeMembers: 0, recentHighlights: [] },
  actionItems: [],
};

let originalResolved: () => Intl.ResolvedDateTimeFormatOptions;

beforeEach(() => {
  originalResolved = Intl.DateTimeFormat.prototype.resolvedOptions;
  Intl.DateTimeFormat.prototype.resolvedOptions = function () {
    return { timeZone: "America/New_York" } as Intl.ResolvedDateTimeFormatOptions;
  };

  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => BRIEFING,
  }) as unknown as typeof fetch;
});

afterEach(() => {
  Intl.DateTimeFormat.prototype.resolvedOptions = originalResolved;
  jest.clearAllMocks();
});

function lastBriefingUrl(): string {
  const calls = (global.fetch as jest.Mock).mock.calls
    .map((c) => String(c[0]))
    .filter((u) => u.startsWith("/api/briefing"));
  return calls[calls.length - 1];
}

describe("MorningBriefing timezone threading", () => {
  it("includes the browser timezone in the initial fetch", async () => {
    render(<MorningBriefing />);
    await waitFor(() =>
      expect(screen.getByText("Good morning, Nick")).toBeInTheDocument(),
    );
    const url = lastBriefingUrl();
    expect(url).toContain("tz=America%2FNew_York");
    expect(url).not.toContain("refresh=true");
  });

  it("composes refresh=true and tz on manual refresh", async () => {
    render(<MorningBriefing />);
    await waitFor(() =>
      expect(screen.getByText("Good morning, Nick")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByText("Refresh"));

    await waitFor(() => {
      const url = lastBriefingUrl();
      expect(url).toContain("refresh=true");
      expect(url).toContain("tz=America%2FNew_York");
    });
  });
});
