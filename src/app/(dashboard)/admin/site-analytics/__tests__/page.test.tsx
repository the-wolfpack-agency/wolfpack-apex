/** @jest-environment jsdom */
import "@testing-library/jest-dom";

const mockFetchWithRefresh = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: any[]) => mockFetchWithRefresh(...a),
  jsonHeaders: () => ({ "Content-Type": "application/json" }),
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
    { key: "fp1", confidence: "proven", behaviorClass: "aggressive_scraper", signals: ["tripped_decoy"], path: ["/_ff/x", "/admin"], eventCount: 2, firstAt: "2026-09-18T10:00:00Z", lastAt: "2026-09-18T10:00:05Z", summary: "Followed an invisible trap link and harvested greedily.", triage: "new", profile: {
      operatorKey: "op_abc12345",
      correlationKey: "fp1",
      verdict: { confidence: "proven", why: "Proven: it followed an invisible, robots-disallowed decoy link that a human cannot see." },
      processes: [{ signal: "tripped_decoy", label: "Tripped the decoy", meaning: "Followed an invisible, robots-disallowed link a person cannot see.", hostile: true }],
      scaffolding: { readsRobotsFirst: false, probedSensitive: false, pathDiscovery: "link-following", requestCount: 2, spanSeconds: 5, observability: "Derived from observed HTTP behavior." },
      toolComposition: { usedTools: ["fetch"], novelTools: [], policies: [], riskTier: "benign", intent: "benign", confidence: "none", summary: "Benign toolset." },
      policies: [],
      timeline: { firstAt: "2026-09-18T10:00:00Z", lastAt: "2026-09-18T10:00:05Z", spanSeconds: 5, eventCount: 2 },
      disclaimer: "Attributes behavior to a consistent operator profile across surfaces. Does NOT establish a real-world identity, which requires legal process.",
      insights: [],
    } },
  ],
  agentOrigins: [
    { country: "US", total: 40, welcomed: 6, flagged: 20, hostile: 14 },
    { country: "DE", total: 12, welcomed: 2, flagged: 10, hostile: 0 },
    { country: "ZZ", total: 3, welcomed: 0, flagged: 0, hostile: 3 },
  ],
  probeIntel: [
    { label: "Cloud metadata endpoint (SSRF / credential theft)", cwe: "CWE-918", severity: "critical" as const, category: "ssrf", count: 2 },
    { label: "Admin surface probe", cwe: "CWE-200", severity: "medium" as const, category: "admin-surface", count: 5 },
  ],
  payloadIntel: [{ attack: "sql_injection", count: 3 }],
  operatorTriage: {},
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
  const journeys = screen.getByTestId("ff-journeys-triage");
  expect(journeys).toHaveTextContent("Aggressive scraper");
  expect(journeys).toHaveTextContent("proven");
  expect(journeys).toHaveTextContent("/_ff/x");
  // Triage: the summary counts render and the hostile group is shown (aggressive
  // scraper is a threat, so it is surfaced, not collapsed with the benign noise).
  expect(screen.getByTestId("triage-summary")).toHaveTextContent("proven");
  expect(screen.getByTestId("triage-group-hostile")).toHaveTextContent("Aggressive scraper");
  // The agent origin map renders a node for a country with a centroid (US).
  expect(screen.getByTestId("agent-origin-map")).toBeInTheDocument();
  expect(screen.getByTestId("origin-node-US")).toBeInTheDocument();
  // Probe intelligence names the specific attack + CWE agents are scanning for.
  const intel = screen.getByTestId("ff-probe-intel");
  expect(intel).toHaveTextContent(/cloud metadata endpoint/i);
  expect(intel).toHaveTextContent("CWE-918");
  // Payload attacks panel names the active exploitation attempts.
  expect(screen.getByTestId("ff-payload-intel")).toHaveTextContent(/sql injection/i);
  // Top pages / countries are collapsed by default (native details, closed).
  expect(screen.getByTestId("top-pages-collapse")).not.toHaveAttribute("open");

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
  await waitFor(() => expect(screen.getByTestId("ff-journeys-triage")).toBeInTheDocument());

  // Profile is collapsed by default.
  expect(screen.queryByTestId("ff-journey-profile-fp1")).not.toBeInTheDocument();

  fireEvent.click(screen.getByTestId("ff-journey-profile-toggle-fp1"));

  const panel = await screen.findByTestId("ff-journey-profile-fp1");
  expect(panel).toHaveTextContent("Why this verdict");
  // A hostile finding whose only observable tool is fetch must NOT show a green
  // "benign" verdict; it shows the not-a-verdict caveat instead.
  expect(screen.getByTestId("tooling-caveat")).toHaveTextContent(/not a verdict on the agent/i);
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


test("triage actions: acknowledge shows a badge + POSTs, dismiss hides the finding behind a toggle", async () => {
  mockFetchWithRefresh.mockResolvedValue({ ok: true, json: async () => ({ summary: SUMMARY }) });
  render(<SiteAnalyticsPage />);
  await waitFor(() => expect(screen.getByTestId("ff-journeys-triage")).toBeInTheDocument());

  // Acknowledge the fp1 finding -> a status badge appears and a POST is sent.
  fireEvent.click(screen.getByTestId("triage-acknowledged-fp1"));
  await waitFor(() => expect(screen.getByTestId("triage-badge-fp1")).toHaveTextContent(/acknowledged/i));
  const call = mockFetchWithRefresh.mock.calls.find((c) => String(c[0]).includes("/api/admin/site-analytics/triage"));
  expect(call).toBeTruthy();
  expect(JSON.parse(call![1].body)).toEqual({ findingKey: "fp1", status: "acknowledged" });

  // Dismiss it -> the card leaves the board, and a "show dismissed" toggle appears.
  fireEvent.click(screen.getByTestId("triage-dismissed-fp1"));
  await waitFor(() => expect(screen.queryByTestId("ff-journey-fp1")).not.toBeInTheDocument());
  const toggle = screen.getByTestId("triage-show-dismissed");
  expect(toggle).toHaveTextContent(/show 1 dismissed/i);

  // Revealing dismissed brings it back.
  fireEvent.click(toggle);
  await waitFor(() => expect(screen.getByTestId("ff-journey-fp1")).toBeInTheDocument());
});

test("surfaces a novel impersonation conclusion as a badge and in the profile panel", async () => {
  const impersonated = {
    ...SUMMARY,
    journeys: [
      {
        ...SUMMARY.journeys[0],
        profile: {
          ...SUMMARY.journeys[0].profile,
          insights: [{ kind: "impersonation" as const, claimedAgent: "GPTBot", detail: "Presented the identity of GPTBot but behaved hostilely." }],
        },
      },
    ],
  };
  mockFetchWithRefresh.mockResolvedValue({ ok: true, json: async () => ({ summary: impersonated }) });
  render(<SiteAnalyticsPage />);
  await waitFor(() => expect(screen.getByTestId("ff-journeys-triage")).toBeInTheDocument());

  // The impersonation badge rides on the card header.
  expect(screen.getByTestId("insight-badge-impersonation-fp1")).toHaveTextContent(/impersonation/i);

  // Expanding the profile shows the novel-conclusions section with the claimed identity.
  fireEvent.click(screen.getByTestId("ff-journey-profile-toggle-fp1"));
  const insights = await screen.findByTestId("insights-fp1");
  expect(insights).toHaveTextContent(/novel conclusions/i);
  expect(insights).toHaveTextContent(/impersonation of gptbot/i);
});


test("by-operator view consolidates findings under one operator with operator-level triage", async () => {
  mockFetchWithRefresh.mockResolvedValue({ ok: true, json: async () => ({ summary: SUMMARY }) });
  render(<SiteAnalyticsPage />);
  await waitFor(() => expect(screen.getByTestId("ff-journeys-triage")).toBeInTheDocument());

  // Switch to the operator view.
  fireEvent.click(screen.getByTestId("journey-view-operator"));
  const opView = await screen.findByTestId("ff-operators-view");
  // fp1's operator (op_abc12345) shows as one consolidated card with a grouping label.
  expect(screen.getByTestId("operator-op_abc12345")).toBeInTheDocument();
  expect(screen.getByTestId("operator-grouping-op_abc12345")).toBeInTheDocument();
  expect(opView).toHaveTextContent(/1 finding/i);

  // Operator-level escalate POSTs under the "op:" key (acts on the whole operator).
  fireEvent.click(screen.getByTestId("operator-triage-escalated-op_abc12345"));
  await waitFor(() => expect(screen.getByTestId("operator-status-op_abc12345")).toHaveTextContent(/escalated/i));
  const call = mockFetchWithRefresh.mock.calls.find((c) => String(c[0]).includes("/triage") && String(c[1]?.body).includes("op:op_abc12345"));
  expect(call).toBeTruthy();
  expect(JSON.parse(call![1].body)).toEqual({ findingKey: "op:op_abc12345", status: "escalated" });
});
