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
    { country: "US", total: 40, welcomed: 6, welcomedVerified: 0, flagged: 20, hostile: 14 },
    { country: "DE", total: 12, welcomed: 2, welcomedVerified: 2, flagged: 10, hostile: 0 },
    { country: "ZZ", total: 3, welcomed: 0, welcomedVerified: 0, flagged: 0, hostile: 3 },
  ],
  probeIntel: [
    { label: "Cloud metadata endpoint (SSRF / credential theft)", cwe: "CWE-918", severity: "critical" as const, category: "ssrf", count: 2 },
    { label: "Admin surface probe", cwe: "CWE-200", severity: "medium" as const, category: "admin-surface", count: 5 },
  ],
  payloadIntel: [{ attack: "sql_injection", count: 3 }],
  operatorTriage: {},
  blockedOperators: [],
};

const PERMS = { triage: true, manageOperators: true };

beforeEach(() => {
  mockFetchWithRefresh.mockReset();
});

test("renders the reused heatmap, totals, and top pages/countries from the summary", async () => {
  mockFetchWithRefresh.mockResolvedValue({
    ok: true,
    json: async () => ({ summary: SUMMARY, permissions: PERMS }),
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
  // Agent journeys panel (severity view): select it, then the correlated session renders.
  fireEvent.click(screen.getByTestId("journey-view-severity"));
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
  mockFetchWithRefresh.mockResolvedValue({ ok: true, json: async () => ({ summary: SUMMARY, permissions: PERMS }) });
  render(<SiteAnalyticsPage />);
  await waitFor(() => expect(screen.getByTestId("ff-journeys-triage")).toBeInTheDocument());
  fireEvent.click(screen.getByTestId("journey-view-severity"));

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
  mockFetchWithRefresh.mockResolvedValue({ ok: true, json: async () => ({ summary: SUMMARY, permissions: PERMS }) });
  render(<SiteAnalyticsPage />);
  await waitFor(() => expect(screen.getByTestId("ff-journeys-triage")).toBeInTheDocument());
  fireEvent.click(screen.getByTestId("journey-view-severity"));

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
  mockFetchWithRefresh.mockResolvedValue({ ok: true, json: async () => ({ summary: impersonated, permissions: PERMS }) });
  render(<SiteAnalyticsPage />);
  await waitFor(() => expect(screen.getByTestId("ff-journeys-triage")).toBeInTheDocument());
  fireEvent.click(screen.getByTestId("journey-view-severity"));

  // The impersonation badge rides on the card header.
  expect(screen.getByTestId("insight-badge-impersonation-fp1")).toHaveTextContent(/impersonation/i);

  // Expanding the profile shows the novel-conclusions section with the claimed identity.
  fireEvent.click(screen.getByTestId("ff-journey-profile-toggle-fp1"));
  const insights = await screen.findByTestId("insights-fp1");
  expect(insights).toHaveTextContent(/novel conclusions/i);
  expect(insights).toHaveTextContent(/impersonation of gptbot/i);
});


test("by-operator view consolidates findings under one operator with operator-level triage", async () => {
  mockFetchWithRefresh.mockResolvedValue({ ok: true, json: async () => ({ summary: SUMMARY, permissions: PERMS }) });
  render(<SiteAnalyticsPage />);
  await waitFor(() => expect(screen.getByTestId("ff-journeys-triage")).toBeInTheDocument());
  fireEvent.click(screen.getByTestId("journey-view-severity"));

  // Switch to the operator view.
  fireEvent.click(screen.getByTestId("journey-view-operator"));
  const opView = await screen.findByTestId("ff-operators-view");
  // fp1's operator (op_abc12345) shows as one consolidated card with a grouping label.
  expect(screen.getByTestId("operator-op_abc12345")).toBeInTheDocument();
  expect(screen.getByTestId("operator-grouping-op_abc12345")).toBeInTheDocument();
  // Targeting signature (A): the /admin path is classified as an admin-surface target.
  expect(screen.getByTestId("operator-targeting-op_abc12345")).toHaveTextContent(/admin-surface/i);
  expect(opView).toHaveTextContent(/1 finding/i);

  // Operator-level escalate POSTs under the "op:" key (acts on the whole operator).
  fireEvent.click(screen.getByTestId("operator-triage-escalated-op_abc12345"));
  await waitFor(() => expect(screen.getByTestId("operator-status-op_abc12345")).toHaveTextContent(/escalated/i));
  const call = mockFetchWithRefresh.mock.calls.find((c) => String(c[0]).includes("/triage") && String(c[1]?.body).includes("op:op_abc12345"));
  expect(call).toBeTruthy();
  expect(JSON.parse(call![1].body)).toEqual({ findingKey: "op:op_abc12345", status: "escalated" });
});


test("blocking an operator POSTs to the block route and shows a blocked badge", async () => {
  mockFetchWithRefresh.mockResolvedValue({ ok: true, json: async () => ({ summary: SUMMARY, permissions: PERMS }) });
  render(<SiteAnalyticsPage />);
  await waitFor(() => expect(screen.getByTestId("ff-journeys-triage")).toBeInTheDocument());
  fireEvent.click(screen.getByTestId("journey-view-severity"));
  fireEvent.click(screen.getByTestId("journey-view-operator"));
  await screen.findByTestId("ff-operators-view");

  // Not blocked initially.
  expect(screen.queryByTestId("operator-blocked-op_abc12345")).not.toBeInTheDocument();
  fireEvent.click(screen.getByTestId("operator-block-op_abc12345"));

  await waitFor(() => expect(screen.getByTestId("operator-blocked-op_abc12345")).toBeInTheDocument());
  const call = mockFetchWithRefresh.mock.calls.find((c) => String(c[0]).includes("/api/admin/operators/block"));
  expect(call).toBeTruthy();
  expect(JSON.parse(call![1].body)).toEqual({ operatorKey: "op_abc12345", block: true });
});

test("promoting an operator POSTs to the promote route and shows an on-board state", async () => {
  mockFetchWithRefresh.mockResolvedValue({ ok: true, json: async () => ({ summary: SUMMARY, permissions: PERMS }) });
  render(<SiteAnalyticsPage />);
  await waitFor(() => expect(screen.getByTestId("ff-journeys-triage")).toBeInTheDocument());
  fireEvent.click(screen.getByTestId("journey-view-severity"));
  fireEvent.click(screen.getByTestId("journey-view-operator"));
  await screen.findByTestId("ff-operators-view");

  fireEvent.click(screen.getByTestId("operator-promote-op_abc12345"));
  await waitFor(() => expect(screen.getByTestId("operator-promote-op_abc12345")).toHaveTextContent(/on board/i));
  const call = mockFetchWithRefresh.mock.calls.find((c) => String(c[0]).includes("/operator/promote"));
  expect(call).toBeTruthy();
  expect(JSON.parse(call![1].body)).toEqual({ operatorKey: "op_abc12345" });
});


test("sub-actors (B): a coarse operator with two distinct targeting profiles shows both, anchored to the coarse key", async () => {
  const j = (key: string, path: string[]) => ({
    key, confidence: "inferred" as const, behaviorClass: "vuln_scanner", signals: [], path,
    eventCount: 1, firstAt: "2026-09-18T10:00:00Z", lastAt: "2026-09-18T10:00:05Z", summary: "probe", triage: "new" as const,
    profile: {
      operatorKey: "op_multi", correlationKey: key,
      verdict: { confidence: "inferred" as const, why: "" },
      processes: [],
      scaffolding: { readsRobotsFirst: false, probedSensitive: true, pathDiscovery: "none", requestCount: 1, spanSeconds: 0, observability: "" },
      toolComposition: { usedTools: ["fetch"], novelTools: [], policies: [], riskTier: "benign" as const, intent: "benign", confidence: "none" as const, summary: "" },
      policies: [], timeline: { firstAt: "2026-09-18T10:00:00Z", lastAt: "2026-09-18T10:00:05Z", spanSeconds: 0, eventCount: 1 },
      disclaimer: "d", insights: [],
    },
  });
  const summary = { ...SUMMARY, journeys: [j("s1", ["/.env"]), j("s2", ["/.git"]), j("s3", ["/wp-login.php"])] };
  mockFetchWithRefresh.mockResolvedValue({ ok: true, json: async () => ({ summary, permissions: PERMS }) });
  render(<SiteAnalyticsPage />);
  await waitFor(() => expect(screen.getByTestId("ff-journeys-triage")).toBeInTheDocument());
  fireEvent.click(screen.getByTestId("journey-view-severity"));
  fireEvent.click(screen.getByTestId("journey-view-operator"));
  await screen.findByTestId("ff-operators-view");

  const sub = await screen.findByTestId("operator-subactors-op_multi");
  // two distinguishable profiles: secrets-exposure (/.env + /.git) and admin-surface (/wp-login.php)
  expect(sub).toHaveTextContent(/2 distinguishable profiles/i);
  expect(sub).toHaveTextContent(/secrets-exposure/i);
  expect(sub).toHaveTextContent(/admin-surface/i);
  // honesty rail: the coarse fingerprint stays the anchor, not a claim of separate identities
  expect(sub).toHaveTextContent(/not separate identities/i);
});

test("a read-only viewer sees the triage board but no journey triage controls", async () => {
  mockFetchWithRefresh.mockResolvedValue({ ok: true, json: async () => ({ summary: SUMMARY, permissions: { triage: false, manageOperators: false } }) });
  render(<SiteAnalyticsPage />);
  await waitFor(() => expect(screen.getByTestId("ff-journeys-triage")).toBeInTheDocument());
  fireEvent.click(screen.getByTestId("journey-view-severity"));
  // The read-only content still renders.
  expect(screen.getByTestId("triage-summary")).toBeInTheDocument();
  // But the write controls do not.
  expect(screen.queryByTestId("triage-acknowledged-fp1")).not.toBeInTheDocument();
  expect(screen.queryByTestId("triage-escalated-fp1")).not.toBeInTheDocument();
});

test("a read-only viewer sees the operator board but no operator controls", async () => {
  mockFetchWithRefresh.mockResolvedValue({ ok: true, json: async () => ({ summary: SUMMARY, permissions: { triage: false, manageOperators: false } }) });
  render(<SiteAnalyticsPage />);
  await waitFor(() => expect(screen.getByTestId("ff-journeys-triage")).toBeInTheDocument());
  fireEvent.click(screen.getByTestId("journey-view-severity"));
  fireEvent.click(screen.getByTestId("journey-view-operator"));
  await screen.findByTestId("ff-operators-view");
  // The operator dossier renders (read-only intelligence)...
  expect(screen.getByTestId("operator-op_abc12345")).toBeInTheDocument();
  // ...but none of the write controls do.
  expect(screen.queryByTestId("operator-triage-escalated-op_abc12345")).not.toBeInTheDocument();
  expect(screen.queryByTestId("operator-block-op_abc12345")).not.toBeInTheDocument();
  expect(screen.queryByTestId("operator-promote-op_abc12345")).not.toBeInTheDocument();
});

test("a triage-capable but non-manager sees triage + promote, but not block", async () => {
  mockFetchWithRefresh.mockResolvedValue({ ok: true, json: async () => ({ summary: SUMMARY, permissions: { triage: true, manageOperators: false } }) });
  render(<SiteAnalyticsPage />);
  await waitFor(() => expect(screen.getByTestId("ff-journeys-triage")).toBeInTheDocument());
  fireEvent.click(screen.getByTestId("journey-view-severity"));
  fireEvent.click(screen.getByTestId("journey-view-operator"));
  await screen.findByTestId("ff-operators-view");
  expect(screen.getByTestId("operator-triage-escalated-op_abc12345")).toBeInTheDocument();
  expect(screen.getByTestId("operator-promote-op_abc12345")).toBeInTheDocument();
  expect(screen.queryByTestId("operator-block-op_abc12345")).not.toBeInTheDocument();
});

test("operator card: codified insight panel (verdict + recommendation) and the journey list is collapsed", async () => {
  mockFetchWithRefresh.mockResolvedValue({ ok: true, json: async () => ({ summary: SUMMARY, permissions: PERMS }) });
  render(<SiteAnalyticsPage />);
  await waitFor(() => expect(screen.getByTestId("ff-journeys-triage")).toBeInTheDocument());
  fireEvent.click(screen.getByTestId("journey-view-severity"));
  fireEvent.click(screen.getByTestId("journey-view-operator"));
  await screen.findByTestId("ff-operators-view");

  // The codified insight leads the card: a verdict + a recommended action.
  expect(screen.getByTestId("operator-insight-op_abc12345")).toBeInTheDocument();
  expect(screen.getByTestId("operator-verdict-op_abc12345")).toHaveTextContent(/proven|likely/i);
  expect(screen.getByTestId("operator-recommend-op_abc12345")).toHaveTextContent(/Recommend:/i);

  // The heavy per-journey list is collapsed behind a "Show N findings" details.
  const findings = screen.getByTestId("operator-findings-op_abc12345");
  expect(findings).toBeInTheDocument();
  expect(findings.tagName.toLowerCase()).toBe("details");
  expect(findings).not.toHaveAttribute("open");
  expect(findings).toHaveTextContent(/Show 1 finding/i);
});

test("journey card renders the agent-path timeline, honeypot trip highlighted", async () => {
  const withSteps = {
    ...SUMMARY,
    journeys: [
      {
        ...SUMMARY.journeys[0],
        steps: [
          { at: "2026-09-18T10:00:00Z", path: "/", signal: null },
          { at: "2026-09-18T10:00:03Z", path: "/_ff/x", signal: "tripped_decoy" },
          { at: "2026-09-18T10:00:05Z", path: "/.env", signal: "probed_sensitive" },
        ],
      },
    ],
  };
  mockFetchWithRefresh.mockResolvedValue({ ok: true, json: async () => ({ summary: withSteps, permissions: PERMS }) });
  render(<SiteAnalyticsPage />);
  await waitFor(() => expect(screen.getByTestId("ff-journeys-triage")).toBeInTheDocument());
  fireEvent.click(screen.getByTestId("journey-view-severity"));
  fireEvent.click(screen.getByTestId("ff-journey-profile-toggle-fp1")); // timeline lives behind Details
  expect(screen.getByTestId("journey-timeline-fp1")).toBeInTheDocument();
  const decoy = screen.getByTestId("journey-timeline-fp1-step-1");
  expect(decoy).toHaveAttribute("data-signal", "tripped_decoy");
  expect(decoy).toHaveTextContent(/TRIPPED DECOY/i);
});

test("operator card surfaces the consolidated path timeline (agent path, prominent)", async () => {
  const withSteps = {
    ...SUMMARY,
    journeys: [
      {
        ...SUMMARY.journeys[0],
        steps: [
          { at: "2026-09-18T10:00:00Z", path: "/", signal: null },
          { at: "2026-09-18T10:00:03Z", path: "/_ff/x", signal: "tripped_decoy" },
        ],
      },
    ],
  };
  mockFetchWithRefresh.mockResolvedValue({ ok: true, json: async () => ({ summary: withSteps, permissions: PERMS }) });
  render(<SiteAnalyticsPage />);
  await waitFor(() => expect(screen.getByTestId("ff-journeys-triage")).toBeInTheDocument());
  fireEvent.click(screen.getByTestId("journey-view-severity"));
  fireEvent.click(screen.getByTestId("journey-view-operator"));
  await screen.findByTestId("ff-operators-view");
  // The operator's whole path chains at the top of the card, not just per finding.
  expect(screen.getByTestId("operator-path-op_abc12345")).toBeInTheDocument();
  const opTl = screen.getByTestId("operator-timeline-op_abc12345");
  expect(opTl).toBeInTheDocument();
  expect(opTl).toHaveTextContent(/TRIPPED DECOY/i);
});

test("operator card shows the agent trust score (0-100 + band) and explicit intent", async () => {
  mockFetchWithRefresh.mockResolvedValue({ ok: true, json: async () => ({ summary: SUMMARY, permissions: PERMS }) });
  render(<SiteAnalyticsPage />);
  await waitFor(() => expect(screen.getByTestId("ff-journeys-triage")).toBeInTheDocument());
  fireEvent.click(screen.getByTestId("journey-view-severity"));
  fireEvent.click(screen.getByTestId("journey-view-operator"));
  await screen.findByTestId("ff-operators-view");
  // A numeric trust score with a band.
  const trust = screen.getByTestId("operator-trust-op_abc12345");
  expect(trust).toHaveTextContent(/\/100/);
  expect(trust).toHaveTextContent(/trusted|caution|untrusted|hostile/i);
  // An explicit intent (what it is trying to do).
  expect(screen.getByTestId("operator-intent-op_abc12345")).toBeInTheDocument();
});

test("operator card shows a 'known on the network' badge when the reputation network flags it", async () => {
  const withRep = {
    ...SUMMARY,
    networkReputation: { op_abc12345: { operatorKey: "op_abc12345", otherWorkspaces: 3, severity: "hostile" as const } },
  };
  mockFetchWithRefresh.mockResolvedValue({ ok: true, json: async () => ({ summary: withRep, permissions: PERMS }) });
  render(<SiteAnalyticsPage />);
  await waitFor(() => expect(screen.getByTestId("ff-journeys-triage")).toBeInTheDocument());
  fireEvent.click(screen.getByTestId("journey-view-severity"));
  fireEvent.click(screen.getByTestId("journey-view-operator"));
  await screen.findByTestId("ff-operators-view");
  const badge = screen.getByTestId("operator-network-op_abc12345");
  expect(badge).toHaveTextContent(/hostile/i);
  expect(badge).toHaveTextContent("3"); // count of OTHER workspaces
  expect(badge).toHaveAttribute("title", expect.stringContaining("other workspace"));
});

test("no network badge when the operator is unknown to the network", async () => {
  mockFetchWithRefresh.mockResolvedValue({ ok: true, json: async () => ({ summary: SUMMARY, permissions: PERMS }) });
  render(<SiteAnalyticsPage />);
  await waitFor(() => expect(screen.getByTestId("ff-journeys-triage")).toBeInTheDocument());
  fireEvent.click(screen.getByTestId("journey-view-severity"));
  fireEvent.click(screen.getByTestId("journey-view-operator"));
  await screen.findByTestId("ff-operators-view");
  expect(screen.queryByTestId("operator-network-op_abc12345")).not.toBeInTheDocument();
});

test("reputation opt-in toggle reflects saved state and POSTs the change", async () => {
  const posted: any[] = [];
  mockFetchWithRefresh.mockImplementation((url: string, opts?: any) => {
    if (String(url).includes("/reputation-optin")) {
      if (opts?.method === "POST") { posted.push(JSON.parse(opts.body)); return Promise.resolve({ ok: true, json: async () => ({ ok: true }) }); }
      return Promise.resolve({ ok: true, json: async () => ({ optIn: { contribute: false, consume: false } }) });
    }
    return Promise.resolve({ ok: true, json: async () => ({ summary: SUMMARY, permissions: PERMS }) });
  });
  render(<SiteAnalyticsPage />);
  await waitFor(() => expect(screen.getByTestId("ff-journeys-triage")).toBeInTheDocument());
  fireEvent.click(screen.getByTestId("journey-view-severity"));
  fireEvent.click(screen.getByTestId("journey-view-operator"));
  await screen.findByTestId("reputation-optin");
  const consume = screen.getByTestId("reputation-optin-consume") as HTMLInputElement;
  await waitFor(() => expect(consume.checked).toBe(false));
  fireEvent.click(consume);
  await waitFor(() => expect(posted).toContainEqual({ contribute: false, consume: true }));
  expect(consume.checked).toBe(true); // optimistic
});

test("reputation opt-in panel is hidden for a viewer who cannot manage operators", async () => {
  mockFetchWithRefresh.mockResolvedValue({ ok: true, json: async () => ({ summary: SUMMARY, permissions: { triage: true, manageOperators: false } }) });
  render(<SiteAnalyticsPage />);
  await waitFor(() => expect(screen.getByTestId("ff-journeys-triage")).toBeInTheDocument());
  fireEvent.click(screen.getByTestId("journey-view-severity"));
  fireEvent.click(screen.getByTestId("journey-view-operator"));
  await screen.findByTestId("ff-operators-view");
  expect(screen.queryByTestId("reputation-optin")).not.toBeInTheDocument();
});


test("operator card shows a VERIFIED principal badge when a delegation was cryptographically verified", async () => {
  const withPrincipal = {
    ...SUMMARY,
    principalByOperator: { op_abc12345: { status: "verified" as const, principal: "person:42", issuer: "acme-fleet", scopes: ["/catalog"], mandateExceeded: false, violations: [] } },
  };
  mockFetchWithRefresh.mockResolvedValue({ ok: true, json: async () => ({ summary: withPrincipal, permissions: PERMS }) });
  render(<SiteAnalyticsPage />);
  await waitFor(() => expect(screen.getByTestId("ff-journeys-triage")).toBeInTheDocument());
  fireEvent.click(screen.getByTestId("journey-view-severity"));
  fireEvent.click(screen.getByTestId("journey-view-operator"));
  await screen.findByTestId("ff-operators-view");
  const badge = screen.getByTestId("operator-principal-op_abc12345");
  expect(badge).toHaveTextContent(/principal verified/i);
  expect(badge).toHaveAttribute("title", expect.stringContaining("acme-fleet"));
});

test("operator card shows a MANDATE EXCEEDED badge when a verified agent stepped outside its scope", async () => {
  const exceeded = {
    ...SUMMARY,
    principalByOperator: { op_abc12345: { status: "verified" as const, principal: "person:42", issuer: "acme-fleet", scopes: ["/catalog"], mandateExceeded: true, violations: ["/admin", "/.env"] } },
  };
  mockFetchWithRefresh.mockResolvedValue({ ok: true, json: async () => ({ summary: exceeded, permissions: PERMS }) });
  render(<SiteAnalyticsPage />);
  await waitFor(() => expect(screen.getByTestId("ff-journeys-triage")).toBeInTheDocument());
  fireEvent.click(screen.getByTestId("journey-view-severity"));
  fireEvent.click(screen.getByTestId("journey-view-operator"));
  await screen.findByTestId("ff-operators-view");
  const badge = screen.getByTestId("operator-principal-op_abc12345");
  expect(badge).toHaveTextContent(/mandate exceeded/i);
  expect(badge).toHaveAttribute("title", expect.stringContaining("/admin"));
});

test("no principal badge when the operator presented no delegation", async () => {
  mockFetchWithRefresh.mockResolvedValue({ ok: true, json: async () => ({ summary: SUMMARY, permissions: PERMS }) });
  render(<SiteAnalyticsPage />);
  await waitFor(() => expect(screen.getByTestId("ff-journeys-triage")).toBeInTheDocument());
  fireEvent.click(screen.getByTestId("journey-view-severity"));
  fireEvent.click(screen.getByTestId("journey-view-operator"));
  await screen.findByTestId("ff-operators-view");
  expect(screen.queryByTestId("operator-principal-op_abc12345")).not.toBeInTheDocument();
});

test("edge-policy panel reflects the loaded mode and the toggle POSTs the change", async () => {
  const posted: any[] = [];
  mockFetchWithRefresh.mockImplementation((url: string, opts?: any) => {
    if (String(url).includes("/edge-policy")) {
      if (opts?.method === "POST") { posted.push(JSON.parse(opts.body)); return Promise.resolve({ ok: true, json: async () => ({ ok: true, mode: "enforce" }) }); }
      return Promise.resolve({ ok: true, json: async () => ({ mode: "monitor" }) });
    }
    return Promise.resolve({ ok: true, json: async () => ({ summary: SUMMARY, permissions: PERMS }) });
  });
  render(<SiteAnalyticsPage />);
  await waitFor(() => expect(screen.getByTestId("ff-journeys-triage")).toBeInTheDocument());
  fireEvent.click(screen.getByTestId("journey-view-severity"));
  fireEvent.click(screen.getByTestId("journey-view-operator"));
  await screen.findByTestId("edge-policy");
  await waitFor(() => expect(screen.getByTestId("edge-policy-mode")).toHaveTextContent(/monitor/i));
  fireEvent.click(screen.getByTestId("edge-policy-toggle"));
  await waitFor(() => expect(posted).toContainEqual({ mode: "enforce", autoBlock: false }));
});

test("operator edge chip shows 'would block' for a blocklisted operator in monitor mode", async () => {
  const blocked = { ...SUMMARY, blockedOperators: ["op_abc12345"] };
  mockFetchWithRefresh.mockImplementation((url: string) => {
    if (String(url).includes("/edge-policy")) return Promise.resolve({ ok: true, json: async () => ({ mode: "monitor" }) });
    return Promise.resolve({ ok: true, json: async () => ({ summary: blocked, permissions: PERMS }) });
  });
  render(<SiteAnalyticsPage />);
  await waitFor(() => expect(screen.getByTestId("ff-journeys-triage")).toBeInTheDocument());
  fireEvent.click(screen.getByTestId("journey-view-severity"));
  fireEvent.click(screen.getByTestId("journey-view-operator"));
  await screen.findByTestId("ff-operators-view");
  const chip = screen.getByTestId("operator-edge-op_abc12345");
  expect(chip).toHaveTextContent(/would block/i);
  expect(chip).toHaveAttribute("title", expect.stringContaining("blocklist"));
});

test("operator edge chip reads 'blocking' (not 'would block') once enforcement is on", async () => {
  const blocked = { ...SUMMARY, blockedOperators: ["op_abc12345"] };
  mockFetchWithRefresh.mockImplementation((url: string) => {
    if (String(url).includes("/edge-policy")) return Promise.resolve({ ok: true, json: async () => ({ mode: "enforce" }) });
    return Promise.resolve({ ok: true, json: async () => ({ summary: blocked, permissions: PERMS }) });
  });
  render(<SiteAnalyticsPage />);
  await waitFor(() => expect(screen.getByTestId("ff-journeys-triage")).toBeInTheDocument());
  fireEvent.click(screen.getByTestId("journey-view-severity"));
  fireEvent.click(screen.getByTestId("journey-view-operator"));
  await screen.findByTestId("ff-operators-view");
  await waitFor(() => expect(screen.getByTestId("operator-edge-op_abc12345")).toHaveTextContent(/^edge: blocking$/i));
});

test("the Forcefield hero switch is prominent - it renders at the top without switching to the operator view", async () => {
  mockFetchWithRefresh.mockImplementation((url: string) => {
    if (String(url).includes("/edge-policy")) return Promise.resolve({ ok: true, json: async () => ({ mode: "monitor" }) });
    return Promise.resolve({ ok: true, json: async () => ({ summary: SUMMARY, permissions: PERMS }) });
  });
  render(<SiteAnalyticsPage />);
  // visible on the default (severity) view, no interaction needed
  await screen.findByTestId("edge-policy");
  expect(screen.getByTestId("edge-policy-mode")).toHaveTextContent(/monitoring/i);
  expect(screen.getByTestId("forcefield-standby-count")).toBeInTheDocument();
});

test("defaults to the By-operator view (the client's actor-centric focus), not the flat severity list", async () => {
  mockFetchWithRefresh.mockImplementation((url: string) => {
    if (String(url).includes("/edge-policy")) return Promise.resolve({ ok: true, json: async () => ({ mode: "monitor" }) });
    return Promise.resolve({ ok: true, json: async () => ({ summary: SUMMARY, permissions: PERMS }) });
  });
  render(<SiteAnalyticsPage />);
  // the operator view is shown on load, without any interaction
  await screen.findByTestId("ff-operators-view");
  // and the flat severity list (its grouped triage summary) is NOT rendered by
  // default, so the client lands on the actor view, not a long scroll
  expect(screen.queryByTestId("triage-summary")).not.toBeInTheDocument();
  expect(screen.queryByTestId("triage-group-hostile")).not.toBeInTheDocument();
});

test("severity view is compact: the finding's summary + timeline are collapsed behind Details", async () => {
  const withSteps = {
    ...SUMMARY,
    journeys: [{ ...SUMMARY.journeys[0], steps: [{ at: "2026-09-18T10:00:03Z", path: "/_ff/x", signal: "tripped_decoy" }] }],
  };
  mockFetchWithRefresh.mockResolvedValue({ ok: true, json: async () => ({ summary: withSteps, permissions: PERMS }) });
  render(<SiteAnalyticsPage />);
  await waitFor(() => expect(screen.getByTestId("ff-journeys-triage")).toBeInTheDocument());
  fireEvent.click(screen.getByTestId("journey-view-severity"));
  // collapsed: a compact path preview stands in for the full timeline
  expect(screen.getByTestId("ff-journey-preview-fp1")).toBeInTheDocument();
  expect(screen.queryByTestId("journey-timeline-fp1")).not.toBeInTheDocument();
  // expanding reveals the full timeline
  fireEvent.click(screen.getByTestId("ff-journey-profile-toggle-fp1"));
  expect(screen.getByTestId("journey-timeline-fp1")).toBeInTheDocument();
  expect(screen.queryByTestId("ff-journey-preview-fp1")).not.toBeInTheDocument();
});

test("clicking a named agent chip in the hero jumps to that operator's card (view switch + highlight)", async () => {
  // make op_abc12345 a would-block agent so it appears as a chip in the hero
  const blocked = { ...SUMMARY, blockedOperators: ["op_abc12345"] };
  mockFetchWithRefresh.mockImplementation((url: string) => {
    if (String(url).includes("/edge-policy")) return Promise.resolve({ ok: true, json: async () => ({ mode: "monitor" }) });
    return Promise.resolve({ ok: true, json: async () => ({ summary: blocked, permissions: PERMS }) });
  });
  render(<SiteAnalyticsPage />);
  const chip = await screen.findByTestId("forcefield-agent-op_abc12345");
  fireEvent.click(chip);
  // it lands on the operator view with that operator's card focused
  await screen.findByTestId("ff-operators-view");
  await waitFor(() => expect(screen.getByTestId("operator-op_abc12345")).toHaveAttribute("data-focused", "true"));
});

test("shows the corpus-wide tradecraft ranking across all operators (insights over the whole dataset)", async () => {
  // A second operator with a distinct exploit signature, so there is more than
  // one operator and the corpus strip renders.
  const j2 = {
    key: "fp2", confidence: "proven", behaviorClass: "exploit_attempt",
    signals: ["payload_attack"], path: ["/api/users"], eventCount: 1,
    firstAt: "2026-09-18T11:00:00Z", lastAt: "2026-09-18T11:00:01Z",
    summary: "Sent a live injection payload.", triage: "new",
    profile: {
      operatorKey: "op_def67890", correlationKey: "fp2",
      verdict: { confidence: "proven", why: "Proven: live injection payload." },
      processes: [],
      scaffolding: { readsRobotsFirst: false, probedSensitive: true, pathDiscovery: "none", requestCount: 1, spanSeconds: 1, observability: "Observed." },
      toolComposition: { usedTools: ["fetch"], novelTools: [], policies: [], riskTier: "dangerous", intent: "exploitation", confidence: "proven", summary: "Injection." },
      policies: [], timeline: { firstAt: "2026-09-18T11:00:00Z", lastAt: "2026-09-18T11:00:01Z", spanSeconds: 1, eventCount: 1 },
      disclaimer: "d", insights: [{ kind: "payload_attack", attack: "sqli" }],
    },
  };
  const twoOps = { ...SUMMARY, journeys: [...SUMMARY.journeys, j2] };
  mockFetchWithRefresh.mockImplementation((url: string) => {
    if (String(url).includes("/edge-policy")) return Promise.resolve({ ok: true, json: async () => ({ mode: "monitor" }) });
    return Promise.resolve({ ok: true, json: async () => ({ summary: twoOps, permissions: PERMS }) });
  });
  render(<SiteAnalyticsPage />);
  await waitFor(() => expect(screen.getByTestId("ff-journeys-triage")).toBeInTheDocument());
  fireEvent.click(screen.getByText("By operator"));
  const corpus = await screen.findByTestId("tradecraft-corpus");
  // both operators' behavior classes appear in the ranking...
  expect(corpus).toHaveTextContent("aggressive_scraper");
  expect(corpus).toHaveTextContent("exploit_attempt");
  // ...and the finer tells (insight kind + trap signal) surface as their own tags
  expect(screen.getByTestId("tradecraft-payload_attack")).toBeInTheDocument();
});
