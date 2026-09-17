/**
 * @jest-environment node
 *
 * Contract for GET /api/admin/effectiveness/dataset. buildDataset mocked - no DB.
 */
import { NextRequest } from "next/server";

const mockCap = jest.fn();
const mockBuild = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: (...a: unknown[]) => mockCap(...a) }));
jest.mock("@/lib/effectiveness/dataset", () => ({
  buildDataset: (...a: unknown[]) => mockBuild(...a),
  liveDatasetDeps: () => ({}),
  toJsonl: (examples: Array<Record<string, unknown>>) => examples.map((e) => JSON.stringify(e)).join("\n"),
}));

import { GET } from "../route";
const OK = { ok: true, user: { id: "u1", role: "admin", workspaceId: "w1" } };
const deny = (s: number) => ({ ok: false, response: new Response("{}", { status: s }) });
const req = (qs = "") => new NextRequest(`http://localhost/api/admin/effectiveness/dataset${qs}`);
const DATA = { examples: [{ source: "secure_agent", label: "block", features: {}, ref: "pr", at: "t" }], counts: { secureAgent: 1, forcefield: 0, total: 1 } };

beforeEach(() => { jest.clearAllMocks(); mockCap.mockResolvedValue(OK); mockBuild.mockResolvedValue(DATA); });

it("401/403 gate", async () => {
  mockCap.mockResolvedValue(deny(403));
  expect((await GET(req())).status).toBe(403);
});
it("default returns JSON with the export, workspace-scoped", async () => {
  const res = await GET(req());
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toMatch(/application\/json/);
  expect(mockBuild).toHaveBeenCalledWith("w1", expect.anything());
  expect((await res.json()).export.counts.total).toBe(1);
});
it("?format=jsonl returns downloadable text, one line per example", async () => {
  const res = await GET(req("?format=jsonl"));
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toMatch(/text\/plain/);
  expect(res.headers.get("content-disposition")).toContain("effectiveness-dataset.jsonl");
  const body = await res.text();
  expect(body.split("\n")).toHaveLength(1);
  expect(JSON.parse(body).label).toBe("block");
});
