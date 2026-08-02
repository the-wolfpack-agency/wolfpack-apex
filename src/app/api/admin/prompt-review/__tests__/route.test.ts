/**
 * Contract for POST /api/admin/prompt-review.
 *
 * The assertion that matters most is the negative one: the brief itself must
 * never reach analytics. A brief routinely names a client, and a surface that
 * quietly logs everything typed into it is a surface nobody should paste a real
 * brief into.
 */
const mockTrackEvent = jest.fn();
let mockAuth: () => Promise<unknown> = async () => ({
  ok: true,
  user: { id: "admin-1", role: "admin", workspaceId: "ws-1" },
});

jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: () => mockAuth() }));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrackEvent(...a) }));

import { NextRequest } from "next/server";
import { POST } from "../route";

const post = (body: unknown, raw?: string) =>
  new NextRequest("http://localhost/api/admin/prompt-review", {
    method: "POST",
    body: raw ?? JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth = async () => ({ ok: true, user: { id: "admin-1", role: "admin", workspaceId: "ws-1" } });
});

describe("POST /api/admin/prompt-review", () => {
  it("returns 200 with the findings", async () => {
    const res = await POST(post({ text: "Make the dashboard better" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.findings.length).toBeGreaterThan(0);
    expect(body.headline).toMatch(/guess at/i);
  });

  it("returns 200 and NO findings for a brief that carries every fact", async () => {
    // A reviewer that cannot return a clean result is a reviewer nobody reads.
    const text = `Fix the login button on https://example.com/admin. Reuse the existing
      hydration gate in app/login/page.tsx. Do not touch the public site. Verify by
      clicking Sign in before the page finishes loading. Open a PR. No new credentials needed.`;
    const body = await (await POST(post({ text }))).json();
    expect(body.findings).toEqual([]);
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth = async () => ({ ok: false, response: new Response(null, { status: 401 }) });
    expect((await POST(post({ text: "x" }))).status).toBe(401);
  });

  it("returns 403 when the capability is missing", async () => {
    mockAuth = async () => ({ ok: false, response: new Response(null, { status: 403 }) });
    expect((await POST(post({ text: "x" }))).status).toBe(403);
  });

  it("returns 400 on a malformed body rather than 500", async () => {
    expect((await POST(post(null, "not json"))).status).toBe(400);
    expect((await POST(post({ text: 42 }))).status).toBe(400);
  });

  it("returns 400 rather than handing the matcher an unbounded string", async () => {
    expect((await POST(post({ text: "a".repeat(20_001) }))).status).toBe(400);
  });

  it("NEVER sends the brief to analytics", async () => {
    const secret = "Acme Corp is unhappy about the March invoice";
    await POST(post({ text: secret }));
    expect(JSON.stringify(mockTrackEvent.mock.calls)).not.toContain("Acme");
    expect(JSON.stringify(mockTrackEvent.mock.calls)).not.toContain("invoice");
  });

  it("records which facts were missing, so the team pattern is answerable", async () => {
    await POST(post({ text: "Make the dashboard better" }));
    const call = mockTrackEvent.mock.calls.find((c) => c[0] === "agent.brief_reviewed");
    expect(call).toBeDefined();
    expect(call![3].dimensions).toContain("environment");
    expect(call![3].findings).toBeGreaterThan(0);
  });
});
