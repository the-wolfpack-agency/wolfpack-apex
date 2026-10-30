/** @jest-environment node */
/**
 * The central decision (WordPress plugin, Cloudflare Worker) applies the site's own
 * AI training crawler policy: a tenant's by its id, one of our sites by its label.
 */
const recordSiteEvent = jest.fn();
const resolveTenantByToken = jest.fn();
const mockPolicy = jest.fn();
jest.mock("@/lib/site-analytics", () => ({ recordSiteEvent: (...a: unknown[]) => recordSiteEvent(...a) }));
jest.mock("@/lib/forcefield/blocked-fingerprints", () => ({ getBlockedFingerprints: async () => [] }));
jest.mock("@/lib/forcefield/datacenter-ranges", () => ({ getDatacenterPrefixes: async () => [] }));
jest.mock("@/lib/forcefield/crawler-ranges", () => ({ getCrawlerRanges: async () => ({}) }));
// Enforce-to-paid gate as the main route test mocks it: an unmanaged site enforces.
jest.mock("@/lib/forcefield-web/billing", () => ({ getSiteBlockEntitlement: async () => null, entitledToBlock: (l: boolean | null) => l !== false }));
jest.mock("@/lib/forcefield-web/tenants", () => ({ resolveTenantByToken: (...a: unknown[]) => resolveTenantByToken(...a) }));
jest.mock("@/lib/analytics", () => ({ trackEvent: jest.fn() }));
jest.mock("@/lib/forcefield/intent-carryover", () => ({ getIntentCarryover: async () => [] }));
jest.mock("@/lib/forcefield/canary-store", () => ({ checkInboundForCanaries: async () => ({ tripped: false, hits: [], severity: "none" }) }));
jest.mock("@/lib/forcefield-web/agent-policy", () => ({
  ...jest.requireActual("@/lib/forcefield-web/agent-policy"),
  getAgentPolicy: (...a: unknown[]) => mockPolicy(...a),
}));
import { NextRequest } from "next/server";
import { POST } from "../route";
import { _resetIntentLedger } from "@/lib/forcefield-web/monitor";
import { _resetRateWindow } from "@/lib/forcefield/rate-window";

const OLD = process.env;
beforeEach(() => {
  jest.clearAllMocks();
  _resetIntentLedger();
  _resetRateWindow();
  process.env = { ...OLD, FORCEFIELD_EDGE_TOKEN: "secret-token" };
  resolveTenantByToken.mockResolvedValue(null);
  recordSiteEvent.mockResolvedValue(undefined);
});
afterAll(() => { process.env = OLD; });

const post = (body: unknown, token = "secret-token") =>
  new NextRequest("http://localhost/api/forcefield/observe", { method: "POST", headers: { "content-type": "application/json", "x-edge-token": token }, body: JSON.stringify(body) });
const gptbot = { site: "weekendwithporsche", path: "/", method: "GET", userAgent: "Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)", headerNames: ["host", "user-agent"], country: "US" };

test("one of our sites: its label's policy turns the crawler away", async () => {
  mockPolicy.mockResolvedValue({ blockedAgents: ["GPTBot"], updatedAt: null });
  const body = await (await POST(post(gptbot))).json();
  expect(body.action).toBe("block");
  expect(mockPolicy).toHaveBeenCalledWith("site:weekendwithporsche");
  expect(recordSiteEvent.mock.calls[0][0].props).toMatchObject({ blocked: true, reason_kind: "agent_policy" });
});

test("a tenant: its own policy by id (the body's site is ignored)", async () => {
  const id = "11111111-2222-3333-4444-555555555555";
  resolveTenantByToken.mockResolvedValue({ id, name: "Acme", siteLabel: "acme", status: "active", sharesIntel: true, enforceEnabled: true });
  mockPolicy.mockResolvedValue({ blockedAgents: ["GPTBot"], updatedAt: null });
  expect((await (await POST(post({ ...gptbot, site: "someone-else" }, "ff_tenant"))).json()).action).toBe("block");
  expect(mockPolicy).toHaveBeenCalledWith(`tenant:${id}`);
});

test("an empty policy (or an unreadable one) lets the crawler in", async () => {
  mockPolicy.mockResolvedValue({ blockedAgents: [], updatedAt: null });
  expect((await (await POST(post(gptbot))).json()).action).toBe("allow");
  mockPolicy.mockRejectedValue(new Error("db down"));
  expect((await (await POST(post(gptbot))).json()).action).toBe("allow");
});
