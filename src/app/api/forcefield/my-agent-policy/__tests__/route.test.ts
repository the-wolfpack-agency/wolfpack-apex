/** @jest-environment node */
/** Contract: the client's own AI training crawler policy (tenant credential), audited and tracked on change. */
import { NextRequest } from "next/server";
const mockResolve = jest.fn();
jest.mock("@/lib/forcefield-web/dashboard-session", () => ({ resolveTenantCredential: (...a: unknown[]) => mockResolve(...a) }));
const mockGet = jest.fn(); const mockSet = jest.fn();
jest.mock("@/lib/forcefield-web/agent-policy", () => ({
  ...jest.requireActual("@/lib/forcefield-web/agent-policy"),
  getAgentPolicy: (...a: unknown[]) => mockGet(...a),
  setAgentPolicy: (...a: unknown[]) => mockSet(...a),
}));
const mockAudit = jest.fn(async (..._a: unknown[]) => {}); const mockTrack = jest.fn();
jest.mock("@/lib/audit-log", () => ({ recordAudit: (...a: unknown[]) => mockAudit(...a), extractRequestMetadata: () => ({}) }));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrack(...a) }));
import { GET, PUT } from "../route";

const TID = "11111111-2222-3333-4444-555555555555";
const TENANT = { tenant: { id: TID, name: "C", siteLabel: "c" } };
const get = (tok = "ff_t") => new NextRequest("http://x/api/forcefield/my-agent-policy", { headers: tok ? { "x-forcefield-token": tok } : {} });
const put = (body: unknown, tok = "ff_t") => new NextRequest("http://x/api/forcefield/my-agent-policy", { method: "PUT", headers: { "x-forcefield-token": tok, "content-type": "application/json" }, body: JSON.stringify(body) });
beforeEach(() => jest.clearAllMocks());

it("401 on GET and PUT without a valid credential; nothing read or written", async () => {
  mockResolve.mockResolvedValue(null);
  expect((await GET(get(""))).status).toBe(401);
  expect((await PUT(put({ blockedAgents: ["GPTBot"] }))).status).toBe(401);
  expect(mockGet).not.toHaveBeenCalled();
  expect(mockSet).not.toHaveBeenCalled();
});
it("GET: the tenant's own policy and the choices (AI training crawlers only)", async () => {
  mockResolve.mockResolvedValue(TENANT);
  mockGet.mockResolvedValue({ blockedAgents: ["ClaudeBot"], updatedAt: "t" });
  const body = await (await GET(get())).json();
  expect(body).toEqual({ ok: true, blockedAgents: ["ClaudeBot"], choices: ["Bytespider", "ClaudeBot", "GPTBot", "Meta-ExternalAgent"], updatedAt: "t" });
  expect(mockGet).toHaveBeenCalledWith(`tenant:${TID}`);
});
it("PUT: 400 for a non-training agent or a malformed body; nothing written", async () => {
  mockResolve.mockResolvedValue(TENANT);
  expect(await (await PUT(put({ blockedAgents: ["OAI-SearchBot"] }))).json()).toEqual({ ok: false, error: "not_a_training_agent" });
  expect((await PUT(put({ nope: 1 }))).status).toBe(400);
  expect(mockSet).not.toHaveBeenCalled();
});
it("PUT: stores the tenant's list, audits before/after and tracks the change", async () => {
  mockResolve.mockResolvedValue(TENANT);
  mockSet.mockResolvedValue({ ok: true, previous: [] });
  const res = await PUT(put({ blockedAgents: ["GPTBot", "ClaudeBot"] }));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, blockedAgents: ["ClaudeBot", "GPTBot"] });
  expect(mockSet).toHaveBeenCalledWith(`tenant:${TID}`, ["ClaudeBot", "GPTBot"], `forcefield_tenant:${TID}`);
  expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "forcefield.agent_policy_changed", beforeState: { blockedAgents: [] }, afterState: { blockedAgents: ["ClaudeBot", "GPTBot"] } }));
  expect(mockTrack).toHaveBeenCalledWith("forcefield.agent_policy_changed", `forcefield_tenant:${TID}`, "tenant", { tenantId: TID, blocked: "ClaudeBot,GPTBot", count: 2 });
});
it("PUT: 503 when the store fails; no audit", async () => {
  mockResolve.mockResolvedValue(TENANT);
  mockSet.mockResolvedValue({ ok: false });
  expect((await PUT(put({ blockedAgents: [] }))).status).toBe(503);
  expect(mockAudit).not.toHaveBeenCalled();
});
