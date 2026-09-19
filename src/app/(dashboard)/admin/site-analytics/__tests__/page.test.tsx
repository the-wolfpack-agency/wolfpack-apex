/** @jest-environment jsdom */
import "@testing-library/jest-dom";

const mockFetchWithRefresh = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: any[]) => mockFetchWithRefresh(...a),
}));

import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import SiteAnalyticsPage from "@/app/(dashboard)/admin/site-analytics/page";

const SUMMARY = {
  rangeDays: 30,
  totalPageViews: 128,
  totalEvents: 190,
  byHour: [
    { hour: 9, count: 12 },
    { hour: 14, count: 30 },
  ],
  byPage: [{ path: "/ogiam-iam", count: 80 }, { path: "/agentic-qa", count: 48 }],
  byCountry: [{ country: "US", count: 90 }],
  byType: [{ type: "site.page_viewed", count: 128 }],
  forcefield: { welcomed: 6, flagged: 9, trapped: 2, topAgents: [{ agent: "GPTBot", count: 6 }] },
  journeys: [
    { key: "fp1", confidence: "proven", behaviorClass: "aggressive_scraper", signals: ["tripped_decoy"], path: ["/_ff/x", "/admin"], eventCount: 2, firstAt: "2026-09-18T10:00:00Z", lastAt: "2026-09-18T10:00:05Z", summary: "Followed an invisible trap link and harvested greedily.", profile: {
      operatorKey: "op_abc12345",
      correlationKey: "fp1",
      verdict: { confidence: "proven", why: "Proven: it followed an invisible, robots-disallowed decoy link that a human cannot see." },
      processes: [{ signal: "tripped_decoy", label: "Tripped the decoy", meaning: "Followed an invisible, robots-disallowed link a person cannot see.", hostile: true }],
      scaffolding: { readsRobotsFirst: false, probedSensitive: false, pathDiscovery: "link-following", requestCount: 2, spanSeconds: 5, observability: "Derived from observed HTTP behavior." },
      toolComposition: { usedTools: ["fetch"], novelTools: [], policies: [], riskTier: "benign", intent: "benign", confidence: "none", summary: "Benign toolset." },
      policies: [],
      timeline: { firstAt: "2026-09-18T10:00:00Z", lastAt: "2026-09-18T10:00:05Z", spanSeconds: 5, eventCount: 2 },
      disclaimer: "Attributes behavior to a consistent operator profile across surfaces. Does NOT establish a real-world identity, which requires legal process.",
    } },
  ],
};

beforeEach(() => {
  mockFetchWithRefresh.mockReset();
});

test("renders the reused heatmap, totals, and top pages/countries from the summary", async () => {
  mockFetchWithRefresh.mockResolvedValue({
    ok: true,
    json: async () => ({ summary: SUMMARY }),
  });

  render(<SiteAnalyticsPage />);

  await waitFor(() => expect(screen.getByTestId("site-hour-heatmap")).toBeInTheDocument());
  // 24 cells in the reused HourHeatmap.
  expect(screen.getAllByTestId("site-hour-cell")).toHaveLength(24);
  expect(screen.getByTestId("total-page-views")).toHaveTextContent("128");
  expect(screen.getByTestId("top-pages")).toHaveTextContent("/ogiam-iam");
  expect(screen.getByTestId("top-countries")).toHaveTextContent("US");
  // The tab is clearly scoped to ogiam.com, and the Forcefield agent-traffic
  // panel renders the welcomed/flagged/trapped counts + top identified agent.
  expect(screen.getByTestId("site-analytics-scope")).toHaveTextContent("ogiam.com");
  expect(screen.getByTestId("ff-welcomed")).toHaveTextContent("6");
  expect(screen.getByTestId("ff-flagged")).toHaveTextContent("9");
  expect(screen.getByTestId("ff-trapped")).toHaveTextContent("2");
  expect(screen.getByTestId("ff-top-agents")).toHaveTextContent("GPTBot");
  // Agent journeys panel: the correlated session renders with its class + proven badge.
  const journeys = screen.getByTestId("ff-journeys-list");
  expect(journeys).toHaveTextContent("Aggressive scraper");
  expect(journeys).toHaveTextContent("proven");
  expect(journeys).toHaveTextContent("/_ff/x");

  // The data route was queried with the default 30-day window.
  expect(String(mockFetchWithRefresh.mock.calls[0][0])).toContain("days=30");
});

test("shows an error state when the data route fails", async () => {
  mockFetchWithRefresh.mockResolvedValue({ ok: false, json: async () => ({}) });
  render(<SiteAnalyticsPage />);
  await waitFor(() => expect(screen.getByTestId("site-analytics-error")).toBeInTheDocument());
});

test("expanding a journey reveals its agent profile: verdict, processes, tooling, operator fingerprint", async () => {
  mockFetchWithRefresh.mockResolvedValue({ ok: true, json: async () => ({ summary: SUMMARY }) });
  render(<SiteAnalyticsPage />);
  await waitFor(() => expect(screen.getByTestId("ff-journeys-list")).toBeInTheDocument());

  // Profile is collapsed by default.
  expect(screen.queryByTestId("ff-journey-profile-fp1")).not.toBeInTheDocument();

  fireEvent.click(screen.getByTestId("ff-journey-profile-toggle-fp1"));

  const panel = await screen.findByTestId("ff-journey-profile-fp1");
  expect(panel).toHaveTextContent("Why this verdict");
  expect(panel).toHaveTextContent("Tripped the decoy");
  expect(panel).toHaveTextContent("Scaffolding");
  expect(panel).toHaveTextContent("fetch");
  expect(panel).toHaveTextContent("Operator fingerprint");
  expect(screen.getByTestId("ff-operator-key-fp1")).toHaveTextContent("op_abc12345");
  expect(panel).toHaveTextContent(/does not establish a real-world identity/i);

  // Collapses again on a second click.
  fireEvent.click(screen.getByTestId("ff-journey-profile-toggle-fp1"));
  expect(screen.queryByTestId("ff-journey-profile-fp1")).not.toBeInTheDocument();
});
