/** @jest-environment jsdom */
/**
 * The "What the edge did" panel and the enforcement-era journey states:
 * blocked vs would-have-blocked, payload families, fast-agent bursts, claimed
 * vs verified identity, signed agents, engine probe labels, ASN, and the
 * explicit empty states.
 */
import "@testing-library/jest-dom";

const mockFetchWithRefresh = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: any[]) => mockFetchWithRefresh(...a),
  jsonHeaders: () => ({ "Content-Type": "application/json" }),
}));

import { render, screen, waitFor } from "@testing-library/react";
import SiteAnalyticsPage from "@/app/(dashboard)/admin/site-analytics/page";

const PROFILE = {
  operatorKey: "op_imp00001",
  correlationKey: "s1",
  verdict: { confidence: "inferred", why: "Claimed GPTBot from the wrong network." },
  processes: [],
  scaffolding: { readsRobotsFirst: false, probedSensitive: true, pathDiscovery: "direct", requestCount: 3, spanSeconds: 2, observability: "Derived from observed HTTP behavior." },
  toolComposition: { usedTools: ["fetch"], novelTools: [], policies: [], riskTier: "benign", intent: "benign", confidence: "none", summary: "Benign toolset." },
  policies: [],
  timeline: { firstAt: "2026-10-20T10:00:00Z", lastAt: "2026-10-20T10:00:02Z", spanSeconds: 2, eventCount: 3 },
  disclaimer: "Does NOT establish a real-world identity.",
  insights: [{ kind: "impersonation", claimedAgent: "GPTBot", detail: "Claimed to be GPTBot, but the request did not come from GPTBot's published network." }],
};

function base(over: Record<string, unknown> = {}) {
  return {
    rangeDays: 30,
    totalPageViews: 0,
    totalEvents: 120,
    byHour: [],
    byPage: [],
    byCountry: [],
    byType: [],
    forcefield: { welcomed: 0, flagged: 0, trapped: 0, blocked: 0, wouldBlock: 0, hostileOperators: 0, hostileEvents: 0, topAgents: [] },
    journeys: [],
    agentOrigins: [],
    probeIntel: [],
    payloadIntel: [],
    operatorTriage: {},
    blockedOperators: [],
    ...over,
  };
}

const FULL_DEFENSE = {
  enforcement: { blocked: 7, wouldBlock: 3, byReason: [{ reason: "payload", blocked: 5, wouldBlock: 1 }, { reason: "decoy", blocked: 2, wouldBlock: 0 }, { reason: "attack_tool", blocked: 0, wouldBlock: 2 }] },
  highRate: { bursts: 4, operators: 2, peakRate: 88, windowSeconds: 10, fromIngest: 1 },
  identity: { verified: 12, impersonation: 3, unverifiable: 2, signed: 1, byAgent: [{ agent: "GPTBot", verified: 12, impersonation: 3, unverifiable: 0, signed: 0 }, { agent: "Claude-User", verified: 0, impersonation: 0, unverifiable: 2, signed: 1 }] },
  probes: [{ probe: "next_server_action", count: 6 }, { probe: "/.env", count: 9 }],
  networks: [{ asn: "16509", org: "AMAZON-02", count: 40, hostile: 11 }],
};

function serve(summary: unknown, permissions = { triage: false, manageOperators: false, viewIntel: true }) {
  mockFetchWithRefresh.mockImplementation(async (url: string) => {
    if (String(url).startsWith("/api/admin/site-analytics")) return { ok: true, json: async () => ({ summary, permissions }) };
    return { ok: false, json: async () => ({}) };
  });
}

beforeEach(() => mockFetchWithRefresh.mockReset());

test("empty window: one explicit empty state, no fake zeros", async () => {
  serve(base());
  render(<SiteAnalyticsPage />);
  await waitFor(() => expect(screen.getByTestId("ff-defense")).toBeInTheDocument());
  expect(screen.getByTestId("ff-defense-empty")).toHaveTextContent(/Nothing blocked or held back/);
  expect(screen.queryByTestId("ff-defense-blocked")).not.toBeInTheDocument();
});

test("blocked and would-have-blocked render side by side, by rule", async () => {
  serve(base({ defense: FULL_DEFENSE }));
  render(<SiteAnalyticsPage />);
  await waitFor(() => expect(screen.getByTestId("ff-defense-enforcement")).toBeInTheDocument());
  expect(screen.getByTestId("ff-defense-blocked")).toHaveTextContent("7");
  expect(screen.getByTestId("ff-defense-would-block")).toHaveTextContent("3");
  expect(screen.getByTestId("ff-defense-enforcement")).toHaveTextContent(/blocking is off or not on this plan/);
  expect(screen.getByTestId("ff-defense-reason-payload")).toHaveTextContent(/attack payload.*5 blocked.*1 would block/);
  expect(screen.getByTestId("ff-defense-reason-attack_tool")).toHaveTextContent(/named attack tool.*2 would block/);
  expect(screen.getByTestId("ff-defense-reason-attack_tool")).not.toHaveTextContent(/blocked/);
});

test("payload attacks render by plain-language family, including the new ones", async () => {
  serve(base({ defense: FULL_DEFENSE, payloadIntel: [{ attack: "nextjs_middleware_bypass", count: 4 }, { attack: "php_cgi_injection", count: 2 }, { attack: "sql_injection", count: 1 }] }));
  render(<SiteAnalyticsPage />);
  await waitFor(() => expect(screen.getByTestId("ff-defense-payloads")).toBeInTheDocument());
  expect(screen.getByTestId("ff-defense-payload-nextjs_middleware_bypass")).toHaveTextContent(/Next\.js middleware bypass\s*4/);
  expect(screen.getByTestId("ff-defense-payload-php_cgi_injection")).toHaveTextContent(/PHP-CGI argument injection/);
  expect(screen.getByTestId("ff-defense-payload-sql_injection")).toHaveTextContent(/SQL injection/);
});

test("fast agents, identity, signed agents, probe labels and ASN", async () => {
  serve(base({ defense: FULL_DEFENSE, agentIntel: { operators: 9, campaigns: 0, automationFleet: 1, aiAgents: 3, scripts: 1, scanners: 2, impersonators: 1, verifiedAgents: 2, persistedAfterBlock: 0, escalatedAfterBlock: 0, topCampaigns: [] } }));
  render(<SiteAnalyticsPage />);
  await waitFor(() => expect(screen.getByTestId("ff-defense-rate")).toBeInTheDocument());
  expect(screen.getByTestId("ff-defense-bursts")).toHaveTextContent("4");
  expect(screen.getByTestId("ff-defense-peak")).toHaveTextContent("88 requests in 10s");
  expect(screen.getByTestId("ff-defense-rate")).toHaveTextContent(/never blocked on speed alone/);
  expect(screen.getByTestId("ff-defense-verified")).toHaveTextContent("12");
  expect(screen.getByTestId("ff-defense-impersonation")).toHaveTextContent("3");
  expect(screen.getByTestId("ff-defense-signed")).toHaveTextContent("1");
  const gpt = screen.getByTestId("ff-defense-agent-GPTBot");
  expect(Array.from(gpt.querySelectorAll("td")).map((c) => c.textContent)).toEqual(["GPTBot", "12", "3", "0", "0"]);
  expect(screen.getByTestId("ff-defense-operator-mix")).toHaveTextContent("2 verified AI agents, 1 impersonator, 2 scanners");
  expect(screen.getByTestId("ff-defense-probe-next_server_action")).toHaveTextContent(/Next\.js server action probe\s*6/);
  expect(screen.getByTestId("ff-defense-probe-/.env")).toHaveTextContent("/.env");
  expect(screen.getByTestId("ff-defense-asn-16509")).toHaveTextContent(/AS16509\s*AMAZON-02\s*40\s*11 hostile/);
});

test("sections without data say so explicitly", async () => {
  serve(base({ defense: { ...FULL_DEFENSE, highRate: { bursts: 0, operators: 0, peakRate: 0, windowSeconds: null, fromIngest: 0 }, identity: { verified: 0, impersonation: 0, unverifiable: 0, signed: 0, byAgent: [] }, probes: [], networks: [] } }));
  render(<SiteAnalyticsPage />);
  await waitFor(() => expect(screen.getByTestId("ff-defense-enforcement")).toBeInTheDocument());
  expect(screen.getByTestId("ff-defense-payloads-empty")).toBeInTheDocument();
  expect(screen.getByTestId("ff-defense-rate-empty")).toBeInTheDocument();
  expect(screen.getByTestId("ff-defense-identity-empty")).toBeInTheDocument();
  expect(screen.getByTestId("ff-defense-networks-empty")).toHaveTextContent(/Cloudflare/);
  expect(screen.queryByTestId("ff-defense-probes")).not.toBeInTheDocument();
});

test("an impersonating operator's path shows blocked vs would-block steps and the impersonation badge", async () => {
  const journey = {
    key: "s1", confidence: "inferred", behaviorClass: "exploit_attempt", signals: ["identified_agent", "payload_attack", "probed_sensitive"],
    path: ["/", "/api/x", "/_next/action"], eventCount: 3, firstAt: "2026-10-20T10:00:00Z", lastAt: "2026-10-20T10:00:02Z",
    summary: "Sent a live injection payload.", triage: "new", insights: PROFILE.insights,
    steps: [
      { at: "2026-10-20T10:00:00Z", path: "/", signal: "identified_agent" },
      { at: "2026-10-20T10:00:01Z", path: "/api/x", signal: "payload_attack", attack: "nextjs_middleware_bypass", blocked: true },
      { at: "2026-10-20T10:00:02Z", path: "/_next/action", signal: "probed_sensitive", probe: "next_server_action", wouldBlock: true },
    ],
    profile: PROFILE,
  };
  serve(base({ journeys: [journey], defense: FULL_DEFENSE }));
  render(<SiteAnalyticsPage />);
  await waitFor(() => expect(screen.getByTestId("operator-timeline-op_imp00001")).toBeInTheDocument());
  expect(screen.getByTestId("operator-timeline-op_imp00001-step-1-outcome")).toHaveTextContent("blocked");
  expect(screen.getByTestId("operator-timeline-op_imp00001-step-1")).toHaveTextContent(/Next\.js middleware bypass/);
  expect(screen.getByTestId("operator-timeline-op_imp00001-step-2-outcome")).toHaveTextContent("would block");
  expect(screen.getByTestId("operator-timeline-op_imp00001-step-2")).toHaveTextContent(/Next\.js server action probe/);
  expect(screen.getByTestId("insight-badge-impersonation-s1")).toHaveTextContent(/impersonation/i);
});

test("a viewer without forcefield.view never sees the defense panel", async () => {
  serve(base({ defense: FULL_DEFENSE }), { triage: false, manageOperators: false, viewIntel: false });
  render(<SiteAnalyticsPage />);
  await waitFor(() => expect(screen.getByTestId("tab-panel-usage")).toBeInTheDocument());
  expect(screen.queryByTestId("ff-defense")).not.toBeInTheDocument();
});
