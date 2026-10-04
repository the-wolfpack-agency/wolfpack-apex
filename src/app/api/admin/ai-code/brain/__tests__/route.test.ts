/** @jest-environment node */
import { NextRequest } from "next/server";

const mockRequireCapability = jest.fn();
const mockServiceAuth = jest.fn();
const mockGate = jest.fn();
const mockCount = jest.fn();
const mockCountFailures = jest.fn();
const mockClient = jest.fn();
const mockTree = jest.fn();
const mockRemember = jest.fn();
const mockIndex = jest.fn();
const mockAudit = jest.fn();
const mockTrack = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: (...a: unknown[]) => mockRequireCapability(...a) }));
jest.mock("@/lib/ai-code/factory-service-auth", () => ({ factoryServiceAuth: (...a: unknown[]) => mockServiceAuth(...a) }));
jest.mock("@/lib/tenancy/require-entitlement", () => ({ requireEntitlement: (...a: unknown[]) => mockGate(...a) }));
jest.mock("@/lib/auth/workspace", () => ({ resolveWorkspace: (w: string) => w }));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrack(...a) }));
jest.mock("@/lib/audit-log", () => ({ recordAuditNonFatal: (...a: unknown[]) => mockAudit(...a), extractRequestMetadata: () => ({}) }));
jest.mock("@/lib/github-client", () => ({ workspaceGithubClient: (...a: unknown[]) => mockClient(...a), fetchRepoTree: (...a: unknown[]) => mockTree(...a) }));
jest.mock("@/lib/ai-code/factory-reuse-store", () => ({ countReuseCorpus: (...a: unknown[]) => mockCount(...a) }));
jest.mock("@/lib/ai-code/factory-failure-store", () => ({ countFailures: (...a: unknown[]) => mockCountFailures(...a) }));
jest.mock("@/lib/ai-code/factory-reuse-producer", () => ({ rememberRepoTree: (...a: unknown[]) => mockRemember(...a) }));
jest.mock("@/lib/ai-code/factory-reuse-index", () => ({ indexReuseCorpus: (...a: unknown[]) => mockIndex(...a) }));

import { GET, POST } from "../route";
const get = () => new NextRequest("http://localhost/api/admin/ai-code/brain");
const post = (body: unknown) => new NextRequest("http://localhost/api/admin/ai-code/brain", { method: "POST", body: JSON.stringify(body) });

beforeEach(() => {
  jest.clearAllMocks();
  mockServiceAuth.mockReturnValue(null);
  mockRequireCapability.mockResolvedValue({ ok: true, user: { id: "u1", role: "admin", workspaceId: "w1" } });
  mockGate.mockResolvedValue(null);
  mockCount.mockResolvedValue(42);
  mockCountFailures.mockResolvedValue(7);
  mockClient.mockResolvedValue({ token: "t" });
  mockTree.mockResolvedValue(["src/a.ts", "src/b.ts"]);
  mockRemember.mockResolvedValue({ written: 2 });
  mockIndex.mockResolvedValue({ indexed: 2 });
  mockAudit.mockResolvedValue({ ok: true });
});

it("401/403 on both verbs", async () => {
  mockRequireCapability.mockResolvedValue({ ok: false, response: new Response("{}", { status: 401 }) });
  expect((await GET(get())).status).toBe(401);
  expect((await POST(post({ repo: "o/r" }))).status).toBe(401);
  mockRequireCapability.mockResolvedValue({ ok: true, user: { id: "u1", role: "admin", workspaceId: "w1" } });
  mockGate.mockResolvedValue(new Response("{}", { status: 403 }));
  expect((await GET(get())).status).toBe(403);
});

it("GET reports the corpus total", async () => {
  const res = await GET(get());
  expect(res.status).toBe(200);
  const g = await res.json();
  expect(g.reuseCorpus.total).toBe(42);
  expect(g.failureMemory.total).toBe(7);
});

it("POST backfills: fetch tree -> remember -> index, audits + tracks", async () => {
  const res = await POST(post({ repo: "acme/app" }));
  expect(res.status).toBe(200);
  const json = await res.json();
  expect(json).toMatchObject({ written: 2, indexed: 2, total: 42 });
  expect(mockRemember).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "w1", repo: "acme/app", treePaths: ["src/a.ts", "src/b.ts"] }));
  expect(mockIndex).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "w1", repo: "acme/app" }));
  expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "ai_code.brain.backfilled" }));
  expect(mockTrack).toHaveBeenCalledWith("ai_code.brain_backfilled", "u1", "admin", expect.objectContaining({ repo: "acme/app", written: 2 }));
});

it("POST 400 on a malformed repo (no write)", async () => {
  expect((await POST(post({ repo: "not-a-repo" }))).status).toBe(400);
  expect(mockRemember).not.toHaveBeenCalled();
});

it("POST reports written:0 (not 500) when GitHub has no token", async () => {
  mockClient.mockResolvedValue({ token: null });
  const res = await POST(post({ repo: "o/r" }));
  expect(res.status).toBe(200);
  expect((await res.json()).written).toBe(0);
  expect(mockRemember).not.toHaveBeenCalled();
});

it("accepts the factory service token", async () => {
  mockServiceAuth.mockReturnValue({ ok: true, user: { id: "svc", role: "service", workspaceId: "w1" } });
  expect((await GET(get())).status).toBe(200);
  expect(mockRequireCapability).not.toHaveBeenCalled();
});
