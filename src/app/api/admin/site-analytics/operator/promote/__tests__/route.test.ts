/** @jest-environment node */
import { NextRequest } from "next/server";

const requireCapability = jest.fn();
const getSiteAnalyticsSummary = jest.fn();
const recordSighting = jest.fn();
const recordAudit = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: (...a: unknown[]) => requireCapability(...a) }));
jest.mock("@/lib/site-analytics", () => ({ getSiteAnalyticsSummary: (...a: unknown[]) => getSiteAnalyticsSummary(...a) }));
jest.mock("@/lib/agent-operators", () => ({ recordSighting: (...a: unknown[]) => recordSighting(...a) }));
jest.mock("@/lib/audit-log", () => ({ recordAudit: (...a: unknown[]) => recordAudit(...a), extractRequestMetadata: () => ({}) }));

import { POST } from "@/app/api/admin/site-analytics/operator/promote/route";

const OK = { ok: true, user: { id: "u1", role: "cto", workspaceId: "w1" } };
const req = (body: unknown) => new NextRequest("http://localhost/api/admin/site-analytics/operator/promote", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

function journeyWith(opKey: string) {
  return {
    key: "k1", confidence: "inferred", behaviorClass: "vuln_scanner", signals: ["probed_sensitive"],
    path: ["/admin"], eventCount: 1, firstAt: "2026-09-19T00:00:00Z", lastAt: "2026-09-19T00:00:05Z", summary: "s", insights: [],
    profile: { operatorKey: opKey, scaffolding: { readsRobotsFirst: false, probedSensitive: true, pathDiscovery: "path-guessing" }, toolComposition: { usedTools: ["fetch"] }, insights: [] },
    triage: "new",
  };
}

beforeEach(() => { requireCapability.mockReset(); getSiteAnalyticsSummary.mockReset(); recordSighting.mockReset(); recordAudit.mockReset(); });

describe("POST /api/admin/site-analytics/operator/promote", () => {
  it("records a sighting per journey and audits the promotion", async () => {
    requireCapability.mockResolvedValueOnce(OK);
    getSiteAnalyticsSummary.mockResolvedValueOnce({ journeys: [journeyWith("op_x"), journeyWith("op_x")] });
    recordSighting.mockResolvedValue("op_x");
    const res = await POST(req({ operatorKey: "op_x" }));
    expect(res.status).toBe(200);
    expect((await res.json())).toEqual({ ok: true, promoted: 2 });
    expect(recordSighting).toHaveBeenCalledTimes(2);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "operator.promoted_to_board", resourceId: "op_x" }));
  });

  it("404s when the operator is not in the current window", async () => {
    requireCapability.mockResolvedValueOnce(OK);
    getSiteAnalyticsSummary.mockResolvedValueOnce({ journeys: [journeyWith("op_other")] });
    const res = await POST(req({ operatorKey: "op_missing" }));
    expect(res.status).toBe(404);
    expect(recordSighting).not.toHaveBeenCalled();
  });

  it("gates on analytics.triage and rejects a missing key", async () => {
    requireCapability.mockResolvedValueOnce({ ok: false, response: new Response("forbidden", { status: 403 }) });
    expect((await POST(req({ operatorKey: "op_x" }))).status).toBe(403);
    requireCapability.mockResolvedValue(OK);
    getSiteAnalyticsSummary.mockResolvedValue({ journeys: [] });
    expect((await POST(req({}))).status).toBe(400);
  });
});
