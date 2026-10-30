/** Contract: the AI training crawler policy for one of our own sites. Read with analytics.view, change with settings.manage_team. */
export {};
const mockRequire = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: (...a: unknown[]) => mockRequire(...a) }));
const mockGet = jest.fn(); const mockSet = jest.fn();
jest.mock("@/lib/forcefield-web/agent-policy", () => ({
  ...jest.requireActual("@/lib/forcefield-web/agent-policy"),
  getAgentPolicy: (...a: unknown[]) => mockGet(...a),
  setAgentPolicy: (...a: unknown[]) => mockSet(...a),
}));
const mockAudit = jest.fn(async (..._a: unknown[]) => {});
jest.mock("@/lib/audit-log", () => ({ recordAudit: (...a: unknown[]) => mockAudit(...a), extractRequestMetadata: () => ({}) }));
jest.mock("@/lib/analytics", () => ({ trackEvent: jest.fn() }));
import { GET, PUT } from "@/app/api/admin/forcefield/agent-policy/route";

const mk = (qs: string, method = "GET", body?: unknown): any => new Request(`http://test/api/admin/forcefield/agent-policy${qs}`, { method, ...(body ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) }) as any;
const user = (caps: string[]) => ({ ok: true, user: { id: "u1", role: "cto", workspaceId: "w1" }, capabilities: new Set(caps) });
beforeEach(() => { jest.clearAllMocks(); mockGet.mockResolvedValue({ blockedAgents: [], updatedAt: null }); });

it.each([401, 403])("%s refused by the gate: nothing read or written", async (status) => {
  mockRequire.mockResolvedValue({ ok: false, response: new Response("{}", { status }) });
  expect((await GET(mk("?site=s"))).status).toBe(status);
  expect((await PUT(mk("?site=s", "PUT", { blockedAgents: ["GPTBot"] }))).status).toBe(status);
  expect(mockGet).not.toHaveBeenCalled();
  expect(mockSet).not.toHaveBeenCalled();
});
it("read needs analytics.view, change needs settings.manage_team", async () => {
  mockRequire.mockResolvedValue(user(["analytics.view"]));
  await GET(mk("?site=s"));
  expect(mockRequire).toHaveBeenLastCalledWith(expect.anything(), "analytics.view");
  mockSet.mockResolvedValue({ ok: true, previous: [] });
  await PUT(mk("?site=s", "PUT", { blockedAgents: [] }));
  expect(mockRequire).toHaveBeenLastCalledWith(expect.anything(), "settings.manage_team");
});
it("GET says whether the caller may change it (canEdit)", async () => {
  mockRequire.mockResolvedValue(user(["analytics.view"]));
  expect((await (await GET(mk("?site=weekendwithporsche"))).json()).canEdit).toBe(false);
  mockRequire.mockResolvedValue(user(["analytics.view", "settings.manage_team"]));
  expect((await (await GET(mk("?site=weekendwithporsche"))).json()).canEdit).toBe(true);
  expect(mockGet).toHaveBeenCalledWith("site:weekendwithporsche");
});
it("400 without a site or with a non-training agent", async () => {
  mockRequire.mockResolvedValue(user(["analytics.view", "settings.manage_team"]));
  expect((await GET(mk(""))).status).toBe(400);
  expect((await PUT(mk("?site=s", "PUT", { blockedAgents: ["Googlebot"] }))).status).toBe(400);
  expect(mockSet).not.toHaveBeenCalled();
});
it("PUT stores for the site scope and audits who changed it", async () => {
  mockRequire.mockResolvedValue(user(["settings.manage_team"]));
  mockSet.mockResolvedValue({ ok: true, previous: ["GPTBot"] });
  const res = await PUT(mk("?site=weekendwithporsche", "PUT", { blockedAgents: ["ClaudeBot"] }));
  expect(res.status).toBe(200);
  expect(mockSet).toHaveBeenCalledWith("site:weekendwithporsche", ["ClaudeBot"], "u1");
  expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "forcefield.agent_policy_changed", resourceId: "weekendwithporsche", beforeState: { blockedAgents: ["GPTBot"] } }));
});
