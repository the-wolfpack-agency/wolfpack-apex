/**
 * /api/brain/pack route contract tests.
 *
 * Locks in HTTP semantics: 401 unauth, 403 wrong workspace / non-member,
 * 400 missing workspace param, 200 happy path with cursor round-trip.
 * Pattern mirrors src/__tests__/brain-routes.test.ts.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

const mockRequireCapability = jest.fn();
const mockSafeQuery = jest.fn();
const mockFetchBrainVectors = jest.fn();
const mockTrackEvent = jest.fn();

jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...args: any[]) => mockRequireCapability(...args),
}));
jest.mock("@/lib/db", () => ({
  safeQuery: (...args: any[]) => mockSafeQuery(...args),
}));
jest.mock("@/lib/brain/qdrant", () => ({
  fetchBrainVectors: (...args: any[]) => mockFetchBrainVectors(...args),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: any[]) => mockTrackEvent(...args),
}));

import { NextRequest, NextResponse } from "next/server";

const AUTHED = {
  ok: true as const,
  user: { id: "u1", role: "cto", name: "Test", email: "t@t.co" },
};
const UNAUTH = {
  ok: false as const,
  response: NextResponse.json({ error: "unauthorized" }, { status: 401 }),
};
const FORBID = {
  ok: false as const,
  response: NextResponse.json({ error: "forbidden" }, { status: 403 }),
};

function get(url: string): NextRequest {
  return new NextRequest(url, { method: "GET" });
}

beforeEach(() => {
  mockRequireCapability.mockReset();
  mockSafeQuery.mockReset();
  mockFetchBrainVectors.mockReset();
  mockTrackEvent.mockReset();
  mockFetchBrainVectors.mockResolvedValue(new Map());
});

describe("GET /api/brain/pack", () => {
  it("401 without auth", async () => {
    mockRequireCapability.mockResolvedValue(UNAUTH);
    const { GET } = await import("@/app/api/brain/pack/route");
    const res = await GET(get("http://x/api/brain/pack?workspace=default"));
    expect(res.status).toBe(401);
  });

  it("403 when capability denied", async () => {
    mockRequireCapability.mockResolvedValue(FORBID);
    const { GET } = await import("@/app/api/brain/pack/route");
    const res = await GET(get("http://x/api/brain/pack?workspace=default"));
    expect(res.status).toBe(403);
  });

  it("400 when workspace param is missing", async () => {
    mockRequireCapability.mockResolvedValue(AUTHED);
    const { GET } = await import("@/app/api/brain/pack/route");
    const res = await GET(get("http://x/api/brain/pack"));
    expect(res.status).toBe(400);
  });

  it("403 when workspace is not 'default' (single-tenant)", async () => {
    mockRequireCapability.mockResolvedValue(AUTHED);
    const { GET } = await import("@/app/api/brain/pack/route");
    const res = await GET(get("http://x/api/brain/pack?workspace=other-ws"));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.reason).toBe("workspace_not_accessible");
  });

  it("403 when user is no longer an active workspace member", async () => {
    mockRequireCapability.mockResolvedValue(AUTHED);
    // membership check returns 0 members.
    mockSafeQuery.mockResolvedValueOnce({
      rows: [{ count: 0 }],
      fromCache: false,
    });
    const { GET } = await import("@/app/api/brain/pack/route");
    const res = await GET(get("http://x/api/brain/pack?workspace=default"));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.reason).toBe("not_a_workspace_member");
  });

  it("200 happy path with chunks, embeddings, and cursor round-trip", async () => {
    mockRequireCapability.mockResolvedValue(AUTHED);
    // membership check ok
    mockSafeQuery.mockResolvedValueOnce({
      rows: [{ count: 1 }],
      fromCache: false,
    });
    // page query returns limit+1 (3 rows for limit=2) to signal "more".
    mockSafeQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "c1",
          document_id: "d1",
          chunk_idx: 0,
          content: "first",
          qdrant_point_id: "p1",
          filename: "a.pdf",
          kind: "pdf",
          created_at: "2024-01-01T00:00:00Z",
        },
        {
          id: "c2",
          document_id: "d1",
          chunk_idx: 1,
          content: "second",
          qdrant_point_id: "p2",
          filename: "a.pdf",
          kind: "pdf",
          created_at: "2024-01-01T00:00:01Z",
        },
        {
          id: "c3",
          document_id: "d2",
          chunk_idx: 0,
          content: "third",
          qdrant_point_id: null,
          filename: "b.pdf",
          kind: "pdf",
          created_at: "2024-01-01T00:00:02Z",
        },
      ],
      fromCache: false,
    });
    // total count
    mockSafeQuery.mockResolvedValueOnce({
      rows: [{ total: 100 }],
      fromCache: false,
    });
    mockFetchBrainVectors.mockResolvedValueOnce(
      new Map([
        ["p1", [0.1, 0.2]],
        ["p2", [0.3, 0.4]],
      ]),
    );

    const { GET } = await import("@/app/api/brain/pack/route");
    const res = await GET(
      get("http://x/api/brain/pack?workspace=default&limit=2"),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("private");
    expect(res.headers.get("cache-control")).toContain("max-age=300");

    const body = await res.json();
    expect(body.chunks).toHaveLength(2);
    expect(body.chunks[0]).toEqual({
      id: "c1",
      doc_id: "d1",
      title: "a.pdf",
      text: "first",
      embedding: [0.1, 0.2],
    });
    expect(body.chunks[1].embedding).toEqual([0.3, 0.4]);
    // Because there were 3 rows for limit=2, there's a next cursor (the
    // id of the last in-page row).
    expect(body.next_cursor).toBe("c2");
    expect(body.total).toBe(100);
  });

  it("200 with next_cursor=null when the last page is short", async () => {
    mockRequireCapability.mockResolvedValue(AUTHED);
    mockSafeQuery.mockResolvedValueOnce({
      rows: [{ count: 1 }],
      fromCache: false,
    });
    mockSafeQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "only",
          document_id: "d1",
          chunk_idx: 0,
          content: "single",
          qdrant_point_id: null,
          filename: "x.pdf",
          kind: "pdf",
          created_at: "2024-01-01T00:00:00Z",
        },
      ],
      fromCache: false,
    });
    mockSafeQuery.mockResolvedValueOnce({
      rows: [{ total: 1 }],
      fromCache: false,
    });

    const { GET } = await import("@/app/api/brain/pack/route");
    const res = await GET(
      get("http://x/api/brain/pack?workspace=default&limit=50"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.chunks).toHaveLength(1);
    expect(body.next_cursor).toBeNull();
  });

  it("carries cursor into the page query so it can resume", async () => {
    mockRequireCapability.mockResolvedValue(AUTHED);
    mockSafeQuery.mockResolvedValueOnce({
      rows: [{ count: 1 }],
      fromCache: false,
    });
    mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: false });
    mockSafeQuery.mockResolvedValueOnce({
      rows: [{ total: 0 }],
      fromCache: false,
    });

    const { GET } = await import("@/app/api/brain/pack/route");
    await GET(
      get(
        "http://x/api/brain/pack?workspace=default&cursor=aaaa1111-2222-3333-4444-555555555555&limit=10",
      ),
    );

    // Second call is the page query. args include the cursor.
    const pageCall = mockSafeQuery.mock.calls[1];
    expect(pageCall[0]).toMatch(/bc\.id > \$1::uuid/);
    expect(pageCall[1][0]).toBe("aaaa1111-2222-3333-4444-555555555555");
    // limit arg is the second param when cursor is present.
    expect(pageCall[1][1]).toBe(11); // limit + 1
  });

  it("200 with empty pack in shadow mode (membership fromCache)", async () => {
    mockRequireCapability.mockResolvedValue(AUTHED);
    mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: true });
    mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: true });
    mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: true });
    const { GET } = await import("@/app/api/brain/pack/route");
    const res = await GET(get("http://x/api/brain/pack?workspace=default"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ chunks: [], next_cursor: null, total: 0 });
  });

  it("fires brain.pack_page_downloaded analytics", async () => {
    mockRequireCapability.mockResolvedValue(AUTHED);
    mockSafeQuery.mockResolvedValueOnce({
      rows: [{ count: 1 }],
      fromCache: false,
    });
    mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: false });
    mockSafeQuery.mockResolvedValueOnce({
      rows: [{ total: 0 }],
      fromCache: false,
    });

    const { GET } = await import("@/app/api/brain/pack/route");
    await GET(get("http://x/api/brain/pack?workspace=default"));
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "brain.pack_page_downloaded",
      "u1",
      "cto",
      expect.objectContaining({ workspace: "default" }),
    );
  });
});
