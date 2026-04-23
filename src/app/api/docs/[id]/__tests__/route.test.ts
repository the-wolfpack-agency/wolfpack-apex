/**
 * PUT / DELETE /api/docs/[id] — unit tests.
 *
 * Mirrors the knowledge/[id] route test style. requireCapability is mocked
 * so we control auth + capability resolution; doc-generator lib is mocked
 * so we assert our route logic (auth gate, ownership check, 404, fanout).
 */

const mockRequireCapability = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...args: unknown[]) => mockRequireCapability(...args),
}));

const mockGetDocumentById = jest.fn();
const mockUpdateDocument = jest.fn();
const mockDeleteDocument = jest.fn();
const mockGetDocuments = jest.fn();
const mockDownloadDocument = jest.fn();
jest.mock("@/lib/doc-generator", () => ({
  getDocumentById: (...args: unknown[]) => mockGetDocumentById(...args),
  updateDocument: (...args: unknown[]) => mockUpdateDocument(...args),
  deleteDocument: (...args: unknown[]) => mockDeleteDocument(...args),
  getDocuments: (...args: unknown[]) => mockGetDocuments(...args),
  downloadDocument: (...args: unknown[]) => mockDownloadDocument(...args),
}));

const mockRecordAudit = jest.fn();
jest.mock("@/lib/audit-log", () => ({
  recordAudit: (...args: unknown[]) => mockRecordAudit(...args),
  extractRequestMetadata: () => ({}),
}));

const mockTrackEvent = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: unknown[]) => mockTrackEvent(...args),
}));

import { NextRequest, NextResponse } from "next/server";
import { PUT, DELETE } from "@/app/api/docs/[id]/route";

function req(method: string, body?: unknown): NextRequest {
  return new NextRequest("http://test/api/docs/doc-1", {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const OWNER_USER = {
  id: "u-owner",
  email: "o@e",
  name: "O",
  role: "dev",
  created_at: "",
};

const STRANGER_USER = {
  id: "u-stranger",
  email: "s@e",
  name: "S",
  role: "sales",
  created_at: "",
};

function allowAs(user: typeof OWNER_USER, capabilities: string[] = []) {
  mockRequireCapability.mockResolvedValueOnce({
    ok: true,
    user,
    capabilities: new Set<string>(capabilities),
  });
}

function denyWith(status: 401 | 403, err: string) {
  mockRequireCapability.mockResolvedValueOnce({
    ok: false,
    response: NextResponse.json({ error: err }, { status }),
  });
}

const DOC = {
  id: "doc-1",
  title: "Foo",
  doc_type: "api_doc",
  content: "# foo",
  format: "markdown",
  generated_from: null,
  generated_by: "u-owner",
  revision: 1,
  tokens_used: 0,
  downloads: 0,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

beforeEach(() => {
  jest.clearAllMocks();
  mockRecordAudit.mockResolvedValue({ id: "a-1", seq: 1, entryHash: "h" });
});

describe("PUT /api/docs/[id]", () => {
  it("401 without auth", async () => {
    denyWith(401, "unauthorized");
    const res = await PUT(req("PUT", { title: "N" }), {
      params: Promise.resolve({ id: "doc-1" }),
    });
    expect(res.status).toBe(401);
    expect(mockUpdateDocument).not.toHaveBeenCalled();
  });

  it("404 when missing", async () => {
    allowAs(OWNER_USER);
    mockGetDocumentById.mockResolvedValueOnce(null);
    const res = await PUT(req("PUT", { title: "N" }), {
      params: Promise.resolve({ id: "missing" }),
    });
    expect(res.status).toBe(404);
  });

  it("403 when non-owner without docs.edit", async () => {
    allowAs(STRANGER_USER, []);
    mockGetDocumentById.mockResolvedValueOnce(DOC);
    const res = await PUT(req("PUT", { title: "N" }), {
      params: Promise.resolve({ id: "doc-1" }),
    });
    expect(res.status).toBe(403);
  });

  it("allows non-owner with docs.edit", async () => {
    allowAs(STRANGER_USER, ["docs.edit"]);
    mockGetDocumentById.mockResolvedValueOnce(DOC);
    mockUpdateDocument.mockResolvedValueOnce({ ...DOC, title: "N" });
    const res = await PUT(req("PUT", { title: "N" }), {
      params: Promise.resolve({ id: "doc-1" }),
    });
    expect(res.status).toBe(200);
  });

  it("400 when no editable field supplied", async () => {
    allowAs(OWNER_USER);
    mockGetDocumentById.mockResolvedValueOnce(DOC);
    const res = await PUT(req("PUT", {}), {
      params: Promise.resolve({ id: "doc-1" }),
    });
    expect(res.status).toBe(400);
  });

  it("200 happy path as owner + audits", async () => {
    allowAs(OWNER_USER);
    mockGetDocumentById.mockResolvedValueOnce(DOC);
    mockUpdateDocument.mockResolvedValueOnce({ ...DOC, title: "Foo2" });
    const res = await PUT(req("PUT", { title: "Foo2" }), {
      params: Promise.resolve({ id: "doc-1" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; document: { title: string } };
    expect(body.ok).toBe(true);
    expect(body.document.title).toBe("Foo2");
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "docs.edited", resourceId: "doc-1" }),
    );
  });
});

describe("DELETE /api/docs/[id]", () => {
  it("401 without auth", async () => {
    denyWith(401, "unauthorized");
    const res = await DELETE(req("DELETE"), {
      params: Promise.resolve({ id: "doc-1" }),
    });
    expect(res.status).toBe(401);
  });

  it("404 when missing", async () => {
    allowAs(OWNER_USER);
    mockGetDocumentById.mockResolvedValueOnce(null);
    const res = await DELETE(req("DELETE"), {
      params: Promise.resolve({ id: "missing" }),
    });
    expect(res.status).toBe(404);
  });

  it("403 when non-owner without docs.edit", async () => {
    allowAs(STRANGER_USER, []);
    mockGetDocumentById.mockResolvedValueOnce(DOC);
    const res = await DELETE(req("DELETE"), {
      params: Promise.resolve({ id: "doc-1" }),
    });
    expect(res.status).toBe(403);
  });

  it("200 happy path as owner + audits", async () => {
    allowAs(OWNER_USER);
    mockGetDocumentById.mockResolvedValueOnce(DOC);
    mockDeleteDocument.mockResolvedValueOnce(true);

    const res = await DELETE(req("DELETE"), {
      params: Promise.resolve({ id: "doc-1" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; id: string };
    expect(body.ok).toBe(true);
    expect(body.id).toBe("doc-1");
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "docs.deleted", resourceId: "doc-1" }),
    );
  });
});
