/**
 * Brain API route contract tests.
 *
 * Exercises the thin route adapters with mocked lib dependencies. The
 * real ingest pipeline + DB are tested separately at the lib layer; this
 * file locks in HTTP semantics: 200 / 201 / 400 / 401 / 403 / 404 / 413.
 *
 * Pattern mirrors src/__tests__/tools-routes.test.ts so the shape of
 * route testing stays uniform across the repo.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

const mockRequireCapability = jest.fn();
const mockIngest = jest.fn();
const mockListDocuments = jest.fn();
const mockGetDocument = jest.fn();
const mockDeleteDocument = jest.fn();
const mockGetChunksForDocument = jest.fn();
const mockQueryBrain = jest.fn();
const mockDeleteByDocumentId = jest.fn();
const mockTrackEvent = jest.fn();

jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...args: any[]) => mockRequireCapability(...args),
}));
jest.mock("@/lib/brain/ingest", () => {
  const actual = jest.requireActual("@/lib/brain/ingest");
  return {
    ...actual,
    ingest: (...args: any[]) => mockIngest(...args),
  };
});
jest.mock("@/lib/brain/repo", () => ({
  listDocuments: (...args: any[]) => mockListDocuments(...args),
  getDocument: (...args: any[]) => mockGetDocument(...args),
  deleteDocument: (...args: any[]) => mockDeleteDocument(...args),
  getChunksForDocument: (...args: any[]) => mockGetChunksForDocument(...args),
}));
jest.mock("@/lib/brain/query", () => ({
  queryBrain: (...args: any[]) => mockQueryBrain(...args),
}));
jest.mock("@/lib/brain/qdrant", () => ({
  deleteByDocumentId: (...args: any[]) => mockDeleteByDocumentId(...args),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: any[]) => mockTrackEvent(...args),
}));

import { NextRequest, NextResponse } from "next/server";

const AUTHED = { ok: true as const, user: { id: "u1", role: "cto", name: "Test", email: "t@t.co" } };
const UNAUTH = {
  ok: false as const,
  response: NextResponse.json({ error: "unauthorized" }, { status: 401 }),
};
const FORBID = {
  ok: false as const,
  response: NextResponse.json({ error: "forbidden" }, { status: 403 }),
};

function makeReq(url: string, opts: { method?: string; body?: any; form?: FormData } = {}) {
  const method = opts.method ?? "GET";
  if (opts.form) {
    return new NextRequest(url, { method, body: opts.form as unknown as BodyInit });
  }
  const isGet = method === "GET" || method === "HEAD";
  return new NextRequest(url, {
    method,
    body: isGet ? undefined : JSON.stringify(opts.body ?? {}),
    headers: { "content-type": "application/json" },
  });
}

describe("POST /api/brain/ingest", () => {
  beforeEach(() => {
    mockRequireCapability.mockReset();
    mockIngest.mockReset();
  });

  it("401 without auth", async () => {
    mockRequireCapability.mockResolvedValue(UNAUTH);
    const { POST } = await import("@/app/api/brain/ingest/route");
    const form = new FormData();
    form.set("file", new File(["hi"], "x.txt", { type: "text/plain" }));
    const res = await POST(makeReq("http://x/api/brain/ingest", { method: "POST", form }));
    expect(res.status).toBe(401);
  });

  it("400 without file", async () => {
    mockRequireCapability.mockResolvedValue(AUTHED);
    const { POST } = await import("@/app/api/brain/ingest/route");
    const form = new FormData();
    const res = await POST(makeReq("http://x/api/brain/ingest", { method: "POST", form }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("file is required");
  });

  it("400 on empty file", async () => {
    mockRequireCapability.mockResolvedValue(AUTHED);
    const { POST } = await import("@/app/api/brain/ingest/route");
    const form = new FormData();
    form.set("file", new File([""], "empty.txt", { type: "text/plain" }));
    const res = await POST(makeReq("http://x/api/brain/ingest", { method: "POST", form }));
    expect(res.status).toBe(400);
  });

  it("400 on path-injection filename", async () => {
    mockRequireCapability.mockResolvedValue(AUTHED);
    const { POST } = await import("@/app/api/brain/ingest/route");
    const form = new FormData();
    form.set("file", new File(["data"], "../../etc/passwd", { type: "text/plain" }));
    const res = await POST(makeReq("http://x/api/brain/ingest", { method: "POST", form }));
    expect(res.status).toBe(400);
  });

  it("201 with ingest result on happy path", async () => {
    mockRequireCapability.mockResolvedValue(AUTHED);
    mockIngest.mockResolvedValue({
      document_id: "doc-1",
      status: "indexed",
      chunk_count: 3,
      extracted_chars: 1234,
    });
    const { POST } = await import("@/app/api/brain/ingest/route");
    const form = new FormData();
    form.set("file", new File(["some content"], "notes.md", { type: "text/markdown" }));
    form.set("tags", JSON.stringify(["ops", "onboarding"]));
    const res = await POST(makeReq("http://x/api/brain/ingest", { method: "POST", form }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.document_id).toBe("doc-1");
    expect(mockIngest).toHaveBeenCalledWith(
      expect.objectContaining({
        filename: "notes.md",
        contentType: "text/markdown",
        tags: ["ops", "onboarding"],
        uploadedBy: "u1",
        uploaderRole: "cto",
      }),
    );
  });

  it("returns duplicate_of on re-upload of existing sha256", async () => {
    mockRequireCapability.mockResolvedValue(AUTHED);
    mockIngest.mockResolvedValue({
      document_id: "doc-1",
      status: "indexed",
      chunk_count: 3,
      extracted_chars: 1234,
      duplicate_of: "doc-1",
    });
    const { POST } = await import("@/app/api/brain/ingest/route");
    const form = new FormData();
    form.set("file", new File(["same content"], "x.txt", { type: "text/plain" }));
    const res = await POST(makeReq("http://x/api/brain/ingest", { method: "POST", form }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.duplicate_of).toBe("doc-1");
  });
});

describe("GET /api/brain/documents", () => {
  beforeEach(() => {
    mockRequireCapability.mockReset();
    mockListDocuments.mockReset();
  });

  it("401 without auth", async () => {
    mockRequireCapability.mockResolvedValue(UNAUTH);
    const { GET } = await import("@/app/api/brain/documents/route");
    const res = await GET(makeReq("http://x/api/brain/documents"));
    expect(res.status).toBe(401);
  });

  it("scopes uploaded_by to self when no param provided", async () => {
    mockRequireCapability.mockResolvedValue(AUTHED);
    mockListDocuments.mockResolvedValue([]);
    const { GET } = await import("@/app/api/brain/documents/route");
    await GET(makeReq("http://x/api/brain/documents"));
    expect(mockListDocuments).toHaveBeenCalledWith(
      expect.objectContaining({ uploadedBy: "u1" }),
    );
  });

  it("returns 400 on invalid kind", async () => {
    mockRequireCapability.mockResolvedValue(AUTHED);
    const { GET } = await import("@/app/api/brain/documents/route");
    const res = await GET(makeReq("http://x/api/brain/documents?kind=garbage"));
    expect(res.status).toBe(400);
  });

  it("returns 400 on invalid status", async () => {
    mockRequireCapability.mockResolvedValue(AUTHED);
    const { GET } = await import("@/app/api/brain/documents/route");
    const res = await GET(makeReq("http://x/api/brain/documents?status=notreal"));
    expect(res.status).toBe(400);
  });

  it("200 with documents and filter echo", async () => {
    mockRequireCapability.mockResolvedValue(AUTHED);
    mockListDocuments.mockResolvedValue([
      { id: "doc-a", filename: "a.pdf", kind: "pdf", status: "indexed" },
    ]);
    const { GET } = await import("@/app/api/brain/documents/route");
    const res = await GET(makeReq("http://x/api/brain/documents?kind=pdf"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.documents).toHaveLength(1);
    expect(body.filters.kind).toBe("pdf");
  });

  it("falls back to self when requesting 'all' without brain.manage", async () => {
    mockRequireCapability
      .mockResolvedValueOnce(AUTHED) // brain.read
      .mockResolvedValueOnce(FORBID); // brain.manage
    mockListDocuments.mockResolvedValue([]);
    const { GET } = await import("@/app/api/brain/documents/route");
    await GET(makeReq("http://x/api/brain/documents?uploaded_by=all"));
    expect(mockListDocuments).toHaveBeenCalledWith(
      expect.objectContaining({ uploadedBy: "u1" }),
    );
  });
});

describe("GET /api/brain/documents/[id]", () => {
  const ctx = { params: Promise.resolve({ id: "11111111-2222-3333-4444-555555555555" }) };

  beforeEach(() => {
    mockRequireCapability.mockReset();
    mockGetDocument.mockReset();
    mockGetChunksForDocument.mockReset();
  });

  it("400 on invalid uuid", async () => {
    mockRequireCapability.mockResolvedValue(AUTHED);
    const { GET } = await import("@/app/api/brain/documents/[id]/route");
    const res = await GET(makeReq("http://x/api/brain/documents/not-a-uuid"), {
      params: Promise.resolve({ id: "not-a-uuid" }),
    });
    expect(res.status).toBe(400);
  });

  it("404 when document missing", async () => {
    mockRequireCapability.mockResolvedValue(AUTHED);
    mockGetDocument.mockResolvedValue(null);
    const { GET } = await import("@/app/api/brain/documents/[id]/route");
    const res = await GET(makeReq("http://x/api/brain/documents/" + "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"), {
      params: Promise.resolve({ id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }),
    });
    expect(res.status).toBe(404);
  });

  it("200 returns document + chunks", async () => {
    mockRequireCapability.mockResolvedValue(AUTHED);
    mockGetDocument.mockResolvedValue({
      id: "doc-1",
      uploaded_by: "u1",
      filename: "x.pdf",
    });
    mockGetChunksForDocument.mockResolvedValue([{ id: "c1", chunk_idx: 0, content: "hello" }]);
    const { GET } = await import("@/app/api/brain/documents/[id]/route");
    const res = await GET(makeReq("http://x/api/brain/documents/id"), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.document.id).toBe("doc-1");
    expect(body.chunks).toHaveLength(1);
  });

  it("403 when non-owner without brain.manage tries to read", async () => {
    mockRequireCapability
      .mockResolvedValueOnce(AUTHED) // brain.read OK
      .mockResolvedValueOnce(FORBID); // brain.manage denied
    mockGetDocument.mockResolvedValue({
      id: "doc-1",
      uploaded_by: "someone_else",
      filename: "x.pdf",
    });
    const { GET } = await import("@/app/api/brain/documents/[id]/route");
    const res = await GET(makeReq("http://x/api/brain/documents/id"), ctx);
    expect(res.status).toBe(403);
  });
});

describe("DELETE /api/brain/documents/[id]", () => {
  const ctx = { params: Promise.resolve({ id: "11111111-2222-3333-4444-555555555555" }) };

  beforeEach(() => {
    mockRequireCapability.mockReset();
    mockDeleteDocument.mockReset();
    mockDeleteByDocumentId.mockReset();
  });

  it("403 without brain.manage", async () => {
    mockRequireCapability.mockResolvedValue(FORBID);
    const { DELETE } = await import("@/app/api/brain/documents/[id]/route");
    const res = await DELETE(makeReq("http://x/api/brain/documents/id", { method: "DELETE" }), ctx);
    expect(res.status).toBe(403);
  });

  it("404 when doc doesn't exist", async () => {
    mockRequireCapability.mockResolvedValue(AUTHED);
    mockDeleteDocument.mockResolvedValue(null);
    const { DELETE } = await import("@/app/api/brain/documents/[id]/route");
    const res = await DELETE(makeReq("http://x/api/brain/documents/id", { method: "DELETE" }), ctx);
    expect(res.status).toBe(404);
  });

  it("200 and kicks off qdrant cleanup on success", async () => {
    mockRequireCapability.mockResolvedValue(AUTHED);
    mockDeleteDocument.mockResolvedValue({ id: "doc-1" });
    mockDeleteByDocumentId.mockResolvedValue(undefined);
    const { DELETE } = await import("@/app/api/brain/documents/[id]/route");
    const res = await DELETE(makeReq("http://x/api/brain/documents/id", { method: "DELETE" }), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deleted).toBe(true);
    expect(mockDeleteByDocumentId).toHaveBeenCalled();
  });
});

describe("POST /api/brain/query", () => {
  beforeEach(() => {
    mockRequireCapability.mockReset();
    mockQueryBrain.mockReset();
  });

  it("401 without auth", async () => {
    mockRequireCapability.mockResolvedValue(UNAUTH);
    const { POST } = await import("@/app/api/brain/query/route");
    const res = await POST(makeReq("http://x/api/brain/query", { method: "POST", body: { query: "x" } }));
    expect(res.status).toBe(401);
  });

  it("400 on missing query", async () => {
    mockRequireCapability.mockResolvedValue(AUTHED);
    const { POST } = await import("@/app/api/brain/query/route");
    const res = await POST(makeReq("http://x/api/brain/query", { method: "POST", body: {} }));
    expect(res.status).toBe(400);
  });

  it("400 on very long query", async () => {
    mockRequireCapability.mockResolvedValue(AUTHED);
    const { POST } = await import("@/app/api/brain/query/route");
    const res = await POST(makeReq("http://x/api/brain/query", {
      method: "POST",
      body: { query: "x".repeat(2100) },
    }));
    expect(res.status).toBe(400);
  });

  it("200 with query result", async () => {
    mockRequireCapability.mockResolvedValue(AUTHED);
    mockQueryBrain.mockResolvedValue({
      query: "escalation",
      hits: [{ chunk_id: "c1", document_filename: "playbook.pdf" }],
      keyword_hits: 1,
      semantic_hits: 0,
      latency_ms: 42,
      tokens_used: 0,
      query_log_id: 99,
    });
    const { POST } = await import("@/app/api/brain/query/route");
    const res = await POST(makeReq("http://x/api/brain/query", {
      method: "POST",
      body: { query: "how do we escalate" },
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hits).toHaveLength(1);
    expect(body.query_log_id).toBe(99);
  });
});
