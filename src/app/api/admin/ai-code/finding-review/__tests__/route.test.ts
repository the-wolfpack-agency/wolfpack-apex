/** @jest-environment node */
import { NextRequest } from "next/server";

const mockRequireCapability = jest.fn();
const mockServiceAuth = jest.fn();
const mockGate = jest.fn();
const mockTrack = jest.fn();
const mockAudit = jest.fn();
const mockLoad = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: (...a: unknown[]) => mockRequireCapability(...a) }));
jest.mock("@/lib/ai-code/factory-service-auth", () => ({ factoryServiceAuth: (...a: unknown[]) => mockServiceAuth(...a) }));
jest.mock("@/lib/tenancy/require-entitlement", () => ({ requireEntitlement: (...a: unknown[]) => mockGate(...a) }));
jest.mock("@/lib/auth/workspace", () => ({ resolveWorkspace: (w: string) => w }));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrack(...a) }));
jest.mock("@/lib/audit-log", () => ({ recordAuditNonFatal: (...a: unknown[]) => mockAudit(...a), extractRequestMetadata: () => ({}) }));
jest.mock("@/lib/ai-code/gate-precision", () => ({
  ...jest.requireActual("@/lib/ai-code/gate-precision"),
  loadGatePrecision: (...a: unknown[]) => mockLoad(...a),
}));

import { GET, POST } from "../route";
const get = () => new NextRequest("http://localhost/api/admin/ai-code/finding-review");
const post = (b: unknown) => new NextRequest("http://localhost/api/admin/ai-code/finding-review", { method: "POST", body: JSON.stringify(b) });

beforeEach(() => {
  jest.clearAllMocks();
  mockServiceAuth.mockReturnValue(null);
  mockRequireCapability.mockResolvedValue({ ok: true, user: { id: "u1", role: "admin", workspaceId: "w1" } });
  mockGate.mockResolvedValue(null);
  mockAudit.mockResolvedValue({ ok: true });
  mockLoad.mockResolvedValue({ windowDays: 30, classes: [] });
});

it("401/403", async () => {
  mockRequireCapability.mockResolvedValue({ ok: false, response: new Response("{}", { status: 401 }) });
  expect((await GET(get())).status).toBe(401);
  expect((await POST(post({ findingClass: "x", verdict: "wrong" }))).status).toBe(401);
  mockRequireCapability.mockResolvedValue({ ok: true, user: { id: "u1", role: "admin", workspaceId: "w1" } });
  mockGate.mockResolvedValue(new Response("{}", { status: 403 }));
  expect((await GET(get())).status).toBe(403);
});

it("GET returns the precision read-model", async () => {
  mockLoad.mockResolvedValue({ windowDays: 30, classes: [{ findingClass: "x", flagged: 2, reviewed: 1, wrong: 1, valid: 0, acceptedRisk: 0, wrongRate: 1 }] });
  const res = await GET(get());
  expect(res.status).toBe(200);
  expect((await res.json()).precision.classes[0].findingClass).toBe("x");
});

it("POST records a human verdict (event + audit) + returns refreshed precision", async () => {
  const res = await POST(post({ findingClass: "logged_credential", verdict: "wrong", severity: "critical", reason: "it was a placeholder, not a real secret" }));
  expect(res.status).toBe(200);
  expect((await res.json()).ok).toBe(true);
  expect(mockTrack).toHaveBeenCalledWith("ai_code.gate_finding_reviewed", "u1", "admin", expect.objectContaining({ finding_class: "logged_credential", verdict: "wrong", severity: "critical" }));
  expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "ai_code.gate_finding.reviewed" }));
});

it("400 on a bad verdict or missing class (no event)", async () => {
  expect((await POST(post({ findingClass: "x", verdict: "nonsense" }))).status).toBe(400);
  expect((await POST(post({ verdict: "wrong" }))).status).toBe(400);
  expect(mockTrack).not.toHaveBeenCalled();
});

it("accepts the factory service token", async () => {
  mockServiceAuth.mockReturnValue({ ok: true, user: { id: "svc", role: "service", workspaceId: "w1" } });
  expect((await GET(get())).status).toBe(200);
  expect(mockRequireCapability).not.toHaveBeenCalled();
});
