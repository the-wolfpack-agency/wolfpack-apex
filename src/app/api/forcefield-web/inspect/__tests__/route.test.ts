/**
 * @jest-environment node
 *
 * Contract for POST /api/forcefield-web/inspect. Classify + posture are real
 * (pure); the recorder is mocked so no analytics write.
 */
import { NextRequest } from "next/server";

const mockCap = jest.fn();
const mockRecord = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: (...a: unknown[]) => mockCap(...a) }));
jest.mock("@/lib/forcefield-web/record", () => ({
  ...jest.requireActual("@/lib/forcefield-web/record"),
  recordWebInspection: (...a: unknown[]) => mockRecord(...a),
  liveRecordWebDeps: () => ({}),
}));

import { POST } from "../route";
const OK = { ok: true, user: { id: "u1", role: "admin", workspaceId: "w1" } };
const deny = (s: number) => ({ ok: false, response: new Response("{}", { status: s }) });
const post = (body: unknown) =>
  new NextRequest("http://localhost/api/forcefield-web/inspect", { method: "POST", body: JSON.stringify(body) });

beforeEach(() => { jest.clearAllMocks(); mockCap.mockResolvedValue(OK); });

it("401/403 gate", async () => {
  mockCap.mockResolvedValue(deny(401));
  expect((await POST(post({ path: "/x" }))).status).toBe(401);
  mockCap.mockResolvedValue(deny(403));
  expect((await POST(post({ path: "/x" }))).status).toBe(403);
});

it("400 when path is missing", async () => {
  expect((await POST(post({ userAgent: "x" }))).status).toBe(400);
});

it("200 classifies a decoy trip, blocks in enforce, and records it", async () => {
  const res = await POST(post({
    path: "/_ff/trap1", method: "GET", userAgent: "Scraper/1", site: "acme.com",
    posture: "enforce", trapPaths: ["/_ff/trap1"], knownAgents: [],
  }));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.verdict.class).toBe("trapped");
  expect(body.decision.action).toBe("block");
  expect(body.decision.blocked).toBe(true);
  expect(mockRecord).toHaveBeenCalled();
});

it("200 welcomes a known agent and never blocks", async () => {
  const res = await POST(post({
    path: "/pricing", userAgent: "AcmeBot/1", trapPaths: [], knownAgents: [{ id: "acme", uaMatch: "AcmeBot" }],
  }));
  const body = await res.json();
  expect(body.verdict.class).toBe("known_agent");
  expect(body.decision.action).toBe("welcome");
  expect(body.decision.blocked).toBe(false);
});
