/**
 * Contract for POST /api/admin/platform-scans/ingest/sarif.
 *
 * Dual auth (CI bearer CRON_SECRET OR settings.manage_team), body validation,
 * and the parseSarif -> recordScan handoff, with the store + auth + audit mocked
 * so no DB is touched. Mirrors the sibling ingest route contract.
 */
const mockRecord = jest.fn();
const mockAuthFn = jest.fn();
const mockAudit = jest.fn();
let mockAuth: () => Promise<unknown> = async () => ({
  ok: true,
  user: { id: "admin-1", role: "admin", workspaceId: "ws-1" },
});

jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: () => {
    mockAuthFn();
    return mockAuth();
  },
}));
jest.mock("@/lib/platform-scan/store", () => ({ recordScan: (...a: unknown[]) => mockRecord(...a) }));
jest.mock("@/lib/audit-log", () => ({
  recordAudit: (...a: unknown[]) => {
    mockAudit(...a);
    return Promise.resolve();
  },
  extractRequestMetadata: () => ({ ipAddress: "1.2.3.4", userAgent: "jest", requestId: "req-1" }),
}));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/admin/platform-scans/ingest/sarif/route";

const SARIF = {
  version: "2.1.0",
  runs: [
    {
      tool: { driver: { name: "semgrep" } },
      results: [
        {
          ruleId: "security.xss",
          properties: { "security-severity": "9.1" },
          message: { text: "xss" },
          locations: [{ physicalLocation: { artifactLocation: { uri: "a.js" }, region: { startLine: 1 } } }],
        },
      ],
    },
  ],
};

function post(body: unknown, headers: Record<string, string> = {}) {
  return POST(
    new NextRequest("http://localhost/api/admin/platform-scans/ingest/sarif", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.CRON_SECRET = "s3cret";
  mockAuth = async () => ({ ok: true, user: { id: "admin-1", role: "admin", workspaceId: "ws-1" } });
  mockRecord.mockResolvedValue({
    scanId: "scan-1",
    findingCount: 1,
    criticalCount: 1,
    autoResolvedCount: 0,
  });
});

it("200 via bearer CRON_SECRET (CI path), records as the sast-scan agent into default ws", async () => {
  const res = await post({ platform: "wolfpack-auto", sarif: SARIF }, { authorization: "Bearer s3cret" });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    ok: true,
    platform: "wolfpack-auto",
    scanId: "scan-1",
    findingCount: 1,
    criticalCount: 1,
    autoResolvedCount: 0,
  });
  expect(mockAuthFn).not.toHaveBeenCalled();
  const arg = mockRecord.mock.calls[0][0];
  expect(arg.workspaceId).toBe("default");
  expect(arg.actorId).toBe("sast-scan");
  expect(arg.actorRole).toBe("agent");
  // parseSarif produced the result: one critical finding on a.js.
  expect(arg.result.platform).toBe("wolfpack-auto");
  expect(arg.result.baseUrl).toBe("sarif:semgrep");
  expect(arg.result.findings).toHaveLength(1);
  expect(arg.result.findings[0].route).toBe("a.js");
  expect(arg.result.findings[0].severity).toBe("critical"); // 9.1
  expect(mockAudit).toHaveBeenCalledWith(
    expect.objectContaining({ action: "platform.scan_ingest_sarif", resourceType: "platform_scan" }),
  );
});

it("200 via capability (user path), records with the user's id/role/workspace", async () => {
  const res = await post({ platform: "wolfpack-auto", sarif: SARIF }); // no bearer
  expect(res.status).toBe(200);
  expect(mockRecord).toHaveBeenCalledWith(
    expect.objectContaining({ workspaceId: "ws-1", actorId: "admin-1", actorRole: "admin" }),
  );
});

it("400 when platform missing/blank (no record call)", async () => {
  const auth = { authorization: "Bearer s3cret" };
  expect((await post({ sarif: SARIF }, auth)).status).toBe(400);
  expect((await post({ platform: "   ", sarif: SARIF }, auth)).status).toBe(400);
  const body = await (await post({ sarif: SARIF }, auth)).json();
  expect(body).toEqual({ ok: false, error: "platform_required" });
  expect(mockRecord).not.toHaveBeenCalled();
});

it("400 when sarif is not an object", async () => {
  const auth = { authorization: "Bearer s3cret" };
  expect((await post({ platform: "p", sarif: "nope" }, auth)).status).toBe(400);
  expect((await post({ platform: "p", sarif: null }, auth)).status).toBe(400);
  expect((await post({ platform: "p" }, auth)).status).toBe(400);
  expect(mockRecord).not.toHaveBeenCalled();
});

it("400 on invalid JSON body", async () => {
  const res = await post("{not json", { authorization: "Bearer s3cret" });
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ ok: false, error: "invalid_json" });
  expect(mockRecord).not.toHaveBeenCalled();
});

it("401/403s when neither auth path succeeds (no record call)", async () => {
  process.env.CRON_SECRET = ""; // cron path disabled
  mockAuth = async () => ({ ok: false, response: new Response(null, { status: 403 }) });
  const res = await post({ platform: "p", sarif: SARIF });
  expect(res.status).toBe(403);
  expect(mockRecord).not.toHaveBeenCalled();
});

it("never 500s: a store throw returns a zeroed 200 (skipped)", async () => {
  mockRecord.mockRejectedValue(new Error("db down"));
  const res = await post({ platform: "p", sarif: SARIF }, { authorization: "Bearer s3cret" });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, skipped: true, scanId: null, findingCount: 0 });
});
