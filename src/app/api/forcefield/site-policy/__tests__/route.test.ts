/** @jest-environment node */
/** Contract: GET /api/forcefield/site-policy authenticates the SITE by its ingest token and returns only its own policy. */
import { NextRequest } from "next/server";
const mockCaller = jest.fn();
jest.mock("@/lib/forcefield-web/ingest-auth", () => ({ resolveIngestCaller: (...a: unknown[]) => mockCaller(...a) }));
const mockGet = jest.fn();
jest.mock("@/lib/forcefield-web/agent-policy", () => ({
  ...jest.requireActual("@/lib/forcefield-web/agent-policy"),
  getAgentPolicy: (...a: unknown[]) => mockGet(...a),
}));
import { GET } from "../route";

const req = (qs = "", token = "t") => new NextRequest(`http://x/api/forcefield/site-policy${qs}`, { headers: token ? { "x-ingest-token": token } : {} });
const TID = "11111111-2222-3333-4444-555555555555";
beforeEach(() => { jest.resetAllMocks(); mockGet.mockResolvedValue({ blockedAgents: ["GPTBot"], updatedAt: null }); });

it("401 for an unknown or missing token; nothing read", async () => {
  mockCaller.mockResolvedValue(null);
  expect((await GET(req("?site=s", ""))).status).toBe(401);
  expect(mockGet).not.toHaveBeenCalled();
});
it("a tenant token reads its OWN tenant's policy; the site parameter cannot point elsewhere", async () => {
  mockCaller.mockResolvedValue({ kind: "tenant", tenant: { id: TID, siteLabel: "theirs" }, edge: false });
  const res = await GET(req("?site=weekendwithporsche"));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, blockedAgents: ["GPTBot"] });
  expect(mockGet).toHaveBeenCalledWith(`tenant:${TID}`);
});
it("a shared token reads the named internal site's policy; 400 without a valid site", async () => {
  mockCaller.mockResolvedValue({ kind: "shared" });
  expect((await GET(req("?site=weekendwithporsche"))).status).toBe(200);
  expect(mockGet).toHaveBeenCalledWith("site:weekendwithporsche");
  expect((await GET(req(""))).status).toBe(400);
  expect((await GET(req("?site=Bad%20Site"))).status).toBe(400);
});
