/**
 * Contract for POST /api/admin/ai-router/probe.
 *
 * The interesting assertions are not the status codes. This route reaches every
 * configured provider endpoint with the deployment's own credentials, so the
 * things worth pinning are: an unauthenticated caller cannot make it fire at
 * all, and a broken model is recorded rather than only counted.
 */
const mockProbeAllModels = jest.fn();
const mockTrackEvent = jest.fn();
const mockRecordAudit = jest.fn();
let mockAuth: () => Promise<unknown> = async () => ({
  ok: true,
  user: { id: "admin-1", role: "admin", workspaceId: "ws-1" },
});

jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: () => mockAuth() }));
jest.mock("@/lib/ai/models/probe", () => ({ probeAllModels: () => mockProbeAllModels() }));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrackEvent(...a) }));
jest.mock("@/lib/audit-log", () => ({ recordAudit: (...a: unknown[]) => mockRecordAudit(...a) }));

import { NextRequest } from "next/server";
import { POST } from "../route";

const post = () => new NextRequest("http://localhost/api/admin/ai-router/probe", { method: "POST" });

const REPORT = {
  results: [
    { modelId: "azure-gpt-4o-mini", outcome: "reachable", latencyMs: 210, status: 200, detail: null },
    { modelId: "azure-deepseek-v3", outcome: "unreachable", latencyMs: 90, status: 404, detail: "the deployment does not exist" },
    { modelId: "gpt-4o", outcome: "not-configured", latencyMs: null, status: null, detail: null },
  ],
  reachable: 1,
  brokenlyConfigured: ["azure-deepseek-v3"],
  headline: "1 model is configured but not answering",
};

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth = async () => ({ ok: true, user: { id: "admin-1", role: "admin", workspaceId: "ws-1" } });
  mockProbeAllModels.mockResolvedValue(REPORT);
  mockRecordAudit.mockResolvedValue({ id: "a", seq: 1, entryHash: "h" });
});

describe("POST /api/admin/ai-router/probe", () => {
  it("returns 200 with the report", async () => {
    const res = await POST(post());
    expect(res.status).toBe(200);
    expect((await res.json()).brokenlyConfigured).toEqual(["azure-deepseek-v3"]);
  });

  it("returns 401 WITHOUT probing anything", async () => {
    // The check that matters: an unauthenticated request must not be able to
    // make the deployment spend money and burn rate limit across every vendor.
    mockAuth = async () => ({ ok: false, response: new Response(null, { status: 401 }) });
    expect((await POST(post())).status).toBe(401);
    expect(mockProbeAllModels).not.toHaveBeenCalled();
  });

  it("returns 403 without probing when the capability is missing", async () => {
    mockAuth = async () => ({ ok: false, response: new Response(null, { status: 403 }) });
    expect((await POST(post())).status).toBe(403);
    expect(mockProbeAllModels).not.toHaveBeenCalled();
  });

  it("records the run so a total exists over time, not just on screen", async () => {
    await POST(post());
    const run = mockTrackEvent.mock.calls.find((c) => c[0] === "ai.model_probe_run");
    expect(run).toBeDefined();
    expect(run![3]).toMatchObject({ models_probed: 3, reachable: 1, broken: 1, not_configured: 1 });
  });

  it("records a row PER broken model, not just the count", async () => {
    // A count tells you something is wrong today. A row per model is what lets
    // the learning loop see a deployment that has been failing for a week.
    await POST(post());
    const broken = mockTrackEvent.mock.calls.filter((c) => c[0] === "ai.model_probe_unreachable");
    expect(broken).toHaveLength(1);
    expect(broken[0][3]).toMatchObject({ model_id: "azure-deepseek-v3", status: 404 });
  });

  it("does not record a not-configured model as broken", async () => {
    // Nobody configured it. Reporting that as a failure would bury the one
    // model that genuinely is failing.
    await POST(post());
    const broken = mockTrackEvent.mock.calls.filter((c) => c[0] === "ai.model_probe_unreachable");
    expect(broken.map((c) => c[3].model_id)).not.toContain("gpt-4o");
  });

  it("audits who reached every provider endpoint", async () => {
    await POST(post());
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "ai.model_probe_run", actor: { user_id: "admin-1", role: "admin" } }),
    );
  });
});
