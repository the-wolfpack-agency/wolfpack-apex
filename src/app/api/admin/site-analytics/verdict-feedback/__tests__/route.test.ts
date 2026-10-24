/** @jest-environment node */
/**
 * Verdict false-positive feedback: analyst-gated, audited, and emitted as a
 * learning event so detection improves and the FP rate is measurable.
 */
const mockRequireCapability = jest.fn();
const mockTrackEvent = jest.fn();
const mockRecordAudit = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: (...a: unknown[]) => mockRequireCapability(...a) }));
jest.mock("@/lib/analytics", () => ({ trackEventAwait: (...a: unknown[]) => mockTrackEvent(...a) }));
const mockSafeQuery = jest.fn();
jest.mock("@/lib/db", () => ({ query: jest.fn(), safeQuery: (...a: unknown[]) => mockSafeQuery(...a) }));
jest.mock("@/lib/audit-log", () => ({ recordAudit: (...a: unknown[]) => mockRecordAudit(...a), extractRequestMetadata: () => ({ ip: "0.0.0.0" }) }));

import { POST } from "../route";

const mkReq = (body: unknown): any => ({ json: async () => body });

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireCapability.mockResolvedValue({ ok: true, user: { id: "u1", role: "cto", workspaceId: "w1" }, capabilities: new Set(["analytics.triage"]) });
  mockRecordAudit.mockResolvedValue({ ok: true });
});

it("401/403 when the caller lacks analytics.triage", async () => {
  mockRequireCapability.mockResolvedValue({ ok: false, response: new Response("{}", { status: 403 }) });
  expect((await POST(mkReq({ operatorKey: "op1" }))).status).toBe(403);
});

it("400 when operatorKey is missing", async () => {
  expect((await POST(mkReq({}))).status).toBe(400);
  expect(mockTrackEvent).not.toHaveBeenCalled();
});

it("records a learning event + an audit entry, workspace-scoped", async () => {
  const res = await POST(mkReq({ operatorKey: "op_abc", findingKey: "fp1", reason: "known good crawler" }));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  expect(mockTrackEvent).toHaveBeenCalledWith(
    "forcefield.verdict_false_positive", "u1", "cto",
    expect.objectContaining({ workspace_id: "w1", operatorKey: "op_abc", findingKey: "fp1", reason: "known good crawler" }),
  );
  expect(mockRecordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "forcefield.verdict_false_positive", resourceId: "op_abc" }));
});

it("writes the workspace where the board's false-positive counter reads it (round trip)", async () => {
  mockTrackEvent.mockResolvedValue(undefined);
  await POST(mkReq({ operatorKey: "op_rt" }));
  const [eventType, , , metadata] = mockTrackEvent.mock.calls[0];
  // The board counts this exact event type, filtered on metadata.<key> = workspace.
  const { countVerdictFalsePositives } = jest.requireActual("@/lib/site-analytics") as typeof import("@/lib/site-analytics");
  mockSafeQuery.mockResolvedValue({ rows: [{ n: "1" }] });
  await countVerdictFalsePositives("w1", 30);
  const [sql, params] = mockSafeQuery.mock.calls[0];
  expect(sql).toContain(`event_type = '${eventType}'`);
  const key = /metadata->>'([a-z_]+)' = \$1/.exec(String(sql))?.[1];
  expect(key).toBe("workspace_id");
  expect((metadata as Record<string, unknown>)[key!]).toBe(params[0]);
});

it("awaits the learning write so a serverless freeze cannot drop it", async () => {
  let settled = false;
  mockTrackEvent.mockImplementation(() => new Promise<void>((r) => setTimeout(() => { settled = true; r(); }, 5)));
  await POST(mkReq({ operatorKey: "op_await" }));
  expect(settled).toBe(true);
});
