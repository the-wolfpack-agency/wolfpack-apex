/**
 * Contract tests for POST /api/admin/ai-surfaces/repo-scan.
 *
 * Auth (401/403), body validation (400 on missing/bad URL), the live-scan happy
 * path (200 — fetchRepoFiles + runDiscovery mocked), workspace-scoping, and the
 * ai_inventory.repo_scan_completed + per-ungoverned ai_inventory.remediation_suggested
 * analytics. Typed fetch errors map to the right status (404). The repo fetch +
 * discovery libs are mocked, so no real GitHub call happens.
 */

export {};

const mockRequireCapability = jest.fn();
const mockFetchRepo = jest.fn();
const mockRunDiscovery = jest.fn();
const mockTrackEvent = jest.fn();

jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: unknown[]) => mockRequireCapability(...a),
}));
jest.mock("@/lib/ai-surface/repo-fetch", () => {
  const actual = jest.requireActual("@/lib/ai-surface/repo-fetch");
  return { ...actual, fetchRepoFiles: (...a: unknown[]) => mockFetchRepo(...a) };
});
jest.mock("@/lib/ai-surface/inventory", () => ({ runDiscovery: (...a: unknown[]) => mockRunDiscovery(...a) }));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrackEvent(...a) }));

import { NextRequest, NextResponse } from "next/server";
import { POST } from "../route";

const okAuth = () => ({ ok: true, user: { id: "u-1", role: "cto", workspaceId: "w-1" }, capabilities: new Set() });
const deny = (s: number) => ({ ok: false, response: NextResponse.json({ error: "no" }, { status: s }) });

function req(body?: unknown): NextRequest {
  return new NextRequest("https://x.test/api/admin/ai-surfaces/repo-scan", {
    method: "POST",
    headers: { authorization: "Bearer t", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.resetAllMocks();
  mockFetchRepo.mockResolvedValue({
    ok: true,
    value: {
      ref: { owner: "o", repo: "r", ref: "main" },
      target: "o/r",
      files: [{ path: "src/a.ts", content: `import OpenAI from "openai";` }],
      treeFileCount: 1,
      fetchedFileCount: 1,
      truncated: false,
    },
  });
  mockRunDiscovery.mockResolvedValue({
    target: "o/r",
    surfaces: [{ kind: "ai_sdk", provider: "openai", location: "src/a.ts:1", governed: false, risk: "medium", evidence: {} }],
    written: 1,
    summary: { total: 1, ungoverned: 1, byKind: { ai_sdk: 1 }, byProvider: { openai: 1 }, byRisk: { medium: 1 } },
    remediations: [{ kind: "ai_sdk", provider: "openai", summary: "x", steps: ["a"], snippet: "s", priority: "later" }],
  });
});

test("401 when unauthenticated", async () => {
  mockRequireCapability.mockResolvedValue(deny(401));
  expect((await POST(req({ url: "https://github.com/o/r" }))).status).toBe(401);
  expect(mockFetchRepo).not.toHaveBeenCalled();
});

test("403 when the capability is missing", async () => {
  mockRequireCapability.mockResolvedValue(deny(403));
  expect((await POST(req({ url: "https://github.com/o/r" }))).status).toBe(403);
});

test("400 on a missing url", async () => {
  mockRequireCapability.mockResolvedValue(okAuth());
  expect((await POST(req({}))).status).toBe(400);
  expect(mockFetchRepo).not.toHaveBeenCalled();
});

test("400 (with kind) on a non-allowed / SSRF-shaped URL", async () => {
  mockRequireCapability.mockResolvedValue(okAuth());
  mockFetchRepo.mockResolvedValue({ ok: false, error: { kind: "invalid_url", message: "only github.com" } });
  const res = await POST(req({ url: "https://gitlab.com/o/r" }));
  expect(res.status).toBe(400);
  expect((await res.json()).kind).toBe("invalid_url");
});

test("404 when the repo is not found (typed error -> status)", async () => {
  mockRequireCapability.mockResolvedValue(okAuth());
  mockFetchRepo.mockResolvedValue({ ok: false, error: { kind: "not_found", message: "no repo" } });
  expect((await POST(req({ url: "https://github.com/o/missing" }))).status).toBe(404);
});

test("200 runs the live scan, is workspace-scoped, and emits the analytics", async () => {
  mockRequireCapability.mockResolvedValue(okAuth());
  const res = await POST(req({ url: "https://github.com/o/r" }));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.result.surfaces).toHaveLength(1);
  expect(body.result.remediations).toHaveLength(1);

  // Workspace-scoped: discovery runs against the caller's workspace.
  expect(mockRunDiscovery).toHaveBeenCalledWith(
    expect.objectContaining({ workspaceId: "w-1", target: "o/r" }),
  );

  // repo_scan_completed fires with the demo metadata.
  expect(mockTrackEvent).toHaveBeenCalledWith(
    "ai_inventory.repo_scan_completed",
    "u-1",
    "cto",
    expect.objectContaining({ repo: "o/r", files_scanned: 1, surfaces: 1, ungoverned: 1 }),
  );
  // One remediation_suggested per ungoverned surface.
  expect(mockTrackEvent).toHaveBeenCalledWith(
    "ai_inventory.remediation_suggested",
    "u-1",
    "cto",
    expect.objectContaining({ kind: "ai_sdk", provider: "openai" }),
  );
});
