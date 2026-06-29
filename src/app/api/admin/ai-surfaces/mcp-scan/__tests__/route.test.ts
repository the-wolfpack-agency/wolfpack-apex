/**
 * Contract tests for POST /api/admin/ai-surfaces/mcp-scan. Auth (401/403), body
 * validation (400 on missing target / empty servers), the happy-path result, and
 * the mcp.scan_completed + per-finding mcp.finding_detected analytics. The scan
 * lib is mocked.
 */

export {};

const mockRequireCapability = jest.fn();
const mockRun = jest.fn();
const mockTrackEvent = jest.fn();

jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: unknown[]) => mockRequireCapability(...a),
}));
jest.mock("@/lib/ai-surface/mcp/scan", () => ({ runMcpScan: (...a: unknown[]) => mockRun(...a) }));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrackEvent(...a) }));

import { NextRequest, NextResponse } from "next/server";
import { POST } from "../route";

const okAuth = () => ({ ok: true, user: { id: "u-1", role: "cto", workspaceId: "w-1" }, capabilities: new Set() });
const deny = (s: number) => ({ ok: false, response: NextResponse.json({ error: "no" }, { status: s }) });
function req(body?: unknown): NextRequest {
  return new NextRequest("https://x.test/api/admin/ai-surfaces/mcp-scan", {
    method: "POST",
    headers: { authorization: "Bearer t", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.resetAllMocks();
  mockRun.mockResolvedValue({
    target: "ws",
    servers: 1,
    findings: [
      { server: "risky", klass: "secret_in_config", severity: "critical", title: "x", detail: "y", evidence: {} },
      { server: "risky", klass: "unpinned_server", severity: "high", title: "x", detail: "y", evidence: {} },
    ],
    written: 1,
    bySeverity: { critical: 1, high: 1 },
    byClass: { secret_in_config: 1, unpinned_server: 1 },
  });
});

test("401 when unauthenticated", async () => {
  mockRequireCapability.mockResolvedValue(deny(401));
  expect((await POST(req({ target: "ws", servers: [{ name: "a" }] }))).status).toBe(401);
});

test("400 on missing target or empty servers", async () => {
  mockRequireCapability.mockResolvedValue(okAuth());
  expect((await POST(req({ servers: [{ name: "a" }] }))).status).toBe(400);
  expect((await POST(req({ target: "ws", servers: [] }))).status).toBe(400);
  expect((await POST(req({ target: "ws", servers: [{ noName: true }] }))).status).toBe(400);
  expect(mockRun).not.toHaveBeenCalled();
});

test("200 runs the scan and emits scan_completed + a finding event per finding", async () => {
  mockRequireCapability.mockResolvedValue(okAuth());
  const res = await POST(req({ target: "ws", servers: [{ name: "risky", command: "npx", args: ["evil-mcp"] }] }));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.result.findings).toHaveLength(2);
  expect(mockRun).toHaveBeenCalledWith(
    expect.objectContaining({ workspaceId: "w-1", target: "ws", servers: [{ name: "risky", command: "npx", args: ["evil-mcp"] }] }),
  );
  expect(mockTrackEvent).toHaveBeenCalledWith(
    "mcp.scan_completed",
    "u-1",
    "cto",
    expect.objectContaining({ target: "ws", servers: 1, findings: 2, critical: 1, high: 1 }),
  );
  expect(mockTrackEvent).toHaveBeenCalledWith(
    "mcp.finding_detected",
    "u-1",
    "cto",
    expect.objectContaining({ server: "risky", class: "secret_in_config", severity: "critical" }),
  );
});
