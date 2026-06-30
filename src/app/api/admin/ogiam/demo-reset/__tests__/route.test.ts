/**
 * Contract test for POST /api/admin/ogiam/demo-reset.
 *
 * Asserts the auth gate (401/403) and the happy path (200 + { result }), and
 * that the seed is hash-chained to the audit log + emits ogiam.demo_seeded. The
 * seed orchestrator is mocked: the route's job is auth -> delegate -> audit ->
 * analytics -> serialize, and that is what we pin here.
 */

import { NextRequest } from "next/server";

const requireCapability = jest.fn();
const seedGovernanceDemo = jest.fn();
const recordAudit = jest.fn();
const trackEvent = jest.fn();

jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: (...a: unknown[]) => requireCapability(...a) }));
jest.mock("@/lib/ogiam/demo-seed", () => ({ seedGovernanceDemo: (...a: unknown[]) => seedGovernanceDemo(...a) }));
jest.mock("@/lib/audit-log", () => ({ recordAudit: (...a: unknown[]) => recordAudit(...a) }));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => trackEvent(...a) }));

import { POST } from "../route";

const RESULT = {
  target: "demo/acme-agent-platform",
  surfaces: { found: 4, written: 4, ungoverned: 4 },
  decisions: { recorded: 5, flagged: 3, wouldBlock: 2 },
  enforcement: [{ capability: "finance.payment", mode: "enforce" }],
  redteam: { attacks: 20, blocked: 20, vulns: 0, passRate: 1 },
  compliance: [{ framework: "SOC2", coverage: 0.8, gap: 1 }],
};

function req(): NextRequest {
  return new NextRequest("http://localhost/api/admin/ogiam/demo-reset", { method: "POST", body: "{}" });
}

beforeEach(() => {
  jest.clearAllMocks();
  requireCapability.mockResolvedValue({ ok: true, user: { id: "u1", role: "admin", workspaceId: "ws1" } });
  seedGovernanceDemo.mockResolvedValue(RESULT);
  recordAudit.mockResolvedValue({ ok: true });
});

test("401 when unauthenticated", async () => {
  requireCapability.mockResolvedValue({ ok: false, response: new Response("no", { status: 401 }) });
  const res = await POST(req());
  expect(res.status).toBe(401);
  expect(seedGovernanceDemo).not.toHaveBeenCalled();
});

test("403 when lacking the capability", async () => {
  requireCapability.mockResolvedValue({ ok: false, response: new Response("nope", { status: 403 }) });
  const res = await POST(req());
  expect(res.status).toBe(403);
  expect(seedGovernanceDemo).not.toHaveBeenCalled();
});

test("200 seeds for the caller's workspace, audits, and emits analytics", async () => {
  const res = await POST(req());
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ result: RESULT });

  // Seeds the caller's workspace, not a hardcoded one.
  expect(seedGovernanceDemo).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws1", actorId: "u1", actorRole: "admin" }));
  // Hash-chained to the audit log.
  expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "ogiam.demo.seeded" }));
  // Learning-loop event with the produced counts.
  expect(trackEvent).toHaveBeenCalledWith("ogiam.demo_seeded", "u1", "admin", expect.objectContaining({ decisions: 5, would_block: 2 }));
});
