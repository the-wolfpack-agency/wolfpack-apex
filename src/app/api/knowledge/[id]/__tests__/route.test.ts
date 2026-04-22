/**
 * PUT/DELETE /api/knowledge/[id] route tests.
 *
 * Mirrors client-assets-route.test.ts: every server dep is mocked, handlers
 * are imported directly, responses are inspected. Covers the auth / valid
 * / 404 / happy-path matrix for both verbs plus the triple-write fanout.
 */

const mockRequireCapability = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...args: unknown[]) => mockRequireCapability(...args),
}));

const mockUpdateAnswer = jest.fn();
const mockDeleteAnswer = jest.fn();
jest.mock("@/lib/knowledge", () => ({
  updateAnswer: (...args: unknown[]) => mockUpdateAnswer(...args),
  deleteAnswer: (...args: unknown[]) => mockDeleteAnswer(...args),
}));

const mockTripleWriteKnowledge = jest.fn();
jest.mock("@/lib/triple-write", () => ({
  tripleWriteKnowledge: (...args: unknown[]) =>
    mockTripleWriteKnowledge(...args),
}));

const mockTrackEvent = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: unknown[]) => mockTrackEvent(...args),
}));

import { NextRequest, NextResponse } from "next/server";
import { PUT, DELETE } from "@/app/api/knowledge/[id]/route";

function req(method: string, body?: unknown): NextRequest {
  return new NextRequest("http://test/api/knowledge/k-1", {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function allowAs(role = "dev", userId = "u-editor") {
  mockRequireCapability.mockResolvedValueOnce({
    ok: true,
    user: {
      id: userId,
      email: "e@test",
      name: "E",
      role,
      created_at: "",
    },
    capabilities: new Set<string>(),
  });
}

function denyWith(status: 401 | 403, err: string) {
  mockRequireCapability.mockResolvedValueOnce({
    ok: false,
    response: NextResponse.json({ error: err }, { status }),
  });
}

const UPDATED_ENTRY = {
  id: "k-1",
  question: "New Q",
  answer: "New A",
  source: "docs",
  asked_by: "u-original",
  confidence: 0,
  rating: null,
  view_count: 0,
  tokens_used: 0,
  tags: ["auth"],
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-04-22T00:00:00Z",
};

beforeEach(() => {
  jest.clearAllMocks();
  mockTripleWriteKnowledge.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// PUT
// ---------------------------------------------------------------------------
describe("PUT /api/knowledge/[id]", () => {
  it("401 without auth", async () => {
    denyWith(401, "unauthorized");
    const res = await PUT(req("PUT", { question: "q", answer: "a" }), {
      params: Promise.resolve({ id: "k-1" }),
    });
    expect(res.status).toBe(401);
    expect(mockUpdateAnswer).not.toHaveBeenCalled();
  });

  it("400 when question is missing", async () => {
    allowAs();
    const res = await PUT(req("PUT", { answer: "only answer" }), {
      params: Promise.resolve({ id: "k-1" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/question/i);
    expect(mockUpdateAnswer).not.toHaveBeenCalled();
  });

  it("400 when answer is missing", async () => {
    allowAs();
    const res = await PUT(req("PUT", { question: "only question" }), {
      params: Promise.resolve({ id: "k-1" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/answer/i);
    expect(mockUpdateAnswer).not.toHaveBeenCalled();
  });

  it("400 when question is blank string", async () => {
    allowAs();
    const res = await PUT(req("PUT", { question: "   ", answer: "a" }), {
      params: Promise.resolve({ id: "k-1" }),
    });
    expect(res.status).toBe(400);
    expect(mockUpdateAnswer).not.toHaveBeenCalled();
  });

  it("404 when updateAnswer returns null", async () => {
    allowAs();
    mockUpdateAnswer.mockResolvedValueOnce(null);
    const res = await PUT(req("PUT", { question: "q", answer: "a" }), {
      params: Promise.resolve({ id: "missing" }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not found");
    // Must not fire a fanout write for a missing row.
    expect(mockTripleWriteKnowledge).not.toHaveBeenCalled();
  });

  it("200 happy path returns { ok, entry } and triggers triple-write", async () => {
    allowAs("dev", "u-editor");
    mockUpdateAnswer.mockResolvedValueOnce(UPDATED_ENTRY);

    const res = await PUT(
      req("PUT", {
        question: "New Q",
        answer: "New A",
        tags: ["auth"],
        source: "docs",
        repo: "wolfpack-apex",
      }),
      { params: Promise.resolve({ id: "k-1" }) },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      entry: { id: string; question: string };
    };
    expect(body.ok).toBe(true);
    expect(body.entry.id).toBe("k-1");

    expect(mockUpdateAnswer).toHaveBeenCalledWith(
      "k-1",
      "New Q",
      "New A",
      "u-editor",
      ["auth"],
      "docs",
    );
    // Fanout is fire-and-forget but must have been invoked.
    expect(mockTripleWriteKnowledge).toHaveBeenCalledWith(
      "k-1",
      "New Q",
      "New A",
      "docs",
      "u-editor",
      ["auth"],
      "wolfpack-apex",
    );
  });

  it("ignores non-string entries in tags array", async () => {
    allowAs("dev", "u-editor");
    mockUpdateAnswer.mockResolvedValueOnce(UPDATED_ENTRY);

    await PUT(
      req("PUT", {
        question: "Q",
        answer: "A",
        tags: ["ok", 42, null, "also-ok"],
      }),
      { params: Promise.resolve({ id: "k-1" }) },
    );

    expect(mockUpdateAnswer).toHaveBeenCalledWith(
      "k-1",
      "Q",
      "A",
      "u-editor",
      ["ok", "also-ok"],
      undefined,
    );
  });
});

// ---------------------------------------------------------------------------
// DELETE
// ---------------------------------------------------------------------------
describe("DELETE /api/knowledge/[id]", () => {
  it("401 without auth", async () => {
    denyWith(401, "unauthorized");
    const res = await DELETE(req("DELETE"), {
      params: Promise.resolve({ id: "k-1" }),
    });
    expect(res.status).toBe(401);
    expect(mockDeleteAnswer).not.toHaveBeenCalled();
  });

  it("200 happy path returns { ok, id } and fires entry_deleted", async () => {
    allowAs("dev", "u-editor");
    mockDeleteAnswer.mockResolvedValueOnce(true);

    const res = await DELETE(req("DELETE"), {
      params: Promise.resolve({ id: "k-1" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; id: string };
    expect(body.ok).toBe(true);
    expect(body.id).toBe("k-1");
    expect(mockDeleteAnswer).toHaveBeenCalledWith("k-1", "u-editor");
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "knowledge.entry_deleted",
      "u-editor",
      "dev",
      expect.objectContaining({ knowledge_id: "k-1" }),
    );
  });

  it("404 when deleteAnswer returns false", async () => {
    allowAs();
    mockDeleteAnswer.mockResolvedValueOnce(false);

    const res = await DELETE(req("DELETE"), {
      params: Promise.resolve({ id: "missing" }),
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not found");
  });
});
