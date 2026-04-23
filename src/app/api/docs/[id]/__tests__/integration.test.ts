/**
 * Integration-style test for /api/docs/[id].
 *
 * Mocks only `@/lib/db` so updateDocument / deleteDocument run real SQL
 * parsing against an in-memory store.
 */

interface Row {
  [k: string]: unknown;
}
const docs: Row[] = [];

// doc-generator uses `query` AND `safeQuery`; both come from @/lib/db.
jest.mock("@/lib/db", () => {
  const handle = async (text: string, params: unknown[] = []) => {
    const n = text.replace(/\s+/g, " ").trim();
    if (/^SELECT \* FROM instinct_documents WHERE id = \$1$/i.test(n)) {
      const found = docs.find((d) => d.id === params[0]);
      return { rows: found ? [found] : [] };
    }
    if (/UPDATE instinct_documents/i.test(n)) {
      const idx = docs.findIndex((d) => d.id === params[0]);
      if (idx === -1) return { rows: [] };
      const fields = ["title", "content", "doc_type"];
      for (let i = 0; i < fields.length; i++) {
        const p = params[i + 1];
        if (p !== null && p !== undefined) docs[idx][fields[i]] = p;
      }
      docs[idx].revision = Number(docs[idx].revision ?? 1) + 1;
      return { rows: [docs[idx]] };
    }
    if (/DELETE FROM instinct_documents WHERE id = \$1/i.test(n)) {
      const idx = docs.findIndex((d) => d.id === params[0]);
      if (idx === -1) return { rows: [], rowCount: 0 };
      docs.splice(idx, 1);
      return { rows: [], rowCount: 1 };
    }
    return { rows: [] };
  };
  return {
    safeQuery: jest.fn(handle),
    query: jest.fn(handle),
    pool: { connect: jest.fn() },
  };
});

jest.mock("@/lib/audit-log", () => ({
  recordAudit: jest.fn().mockResolvedValue({ id: "a", seq: 1, entryHash: "h" }),
  extractRequestMetadata: () => ({}),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: jest.fn(),
}));

jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: jest.fn(),
}));

import { NextRequest } from "next/server";
import { PUT, DELETE } from "@/app/api/docs/[id]/route";
import * as rc from "@/lib/auth/require-capability";

function req(method: string, body?: unknown): NextRequest {
  return new NextRequest("http://test/api/docs/doc-1", {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeAll(() => {
  process.env.DATABASE_URL = "postgres://in-memory-for-test";
});
afterAll(() => {
  delete process.env.DATABASE_URL;
});

beforeEach(() => {
  docs.length = 0;
  docs.push({
    id: "doc-1",
    title: "Old",
    doc_type: "api_doc",
    content: "# Old",
    format: "markdown",
    generated_from: null,
    generated_by: "u-owner",
    revision: 1,
    tokens_used: 0,
    downloads: 0,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  });
  (rc.requireCapability as jest.Mock).mockImplementation(async () => ({
    ok: true,
    user: {
      id: "u-owner",
      email: "o@e",
      name: "O",
      role: "dev",
      created_at: "",
    },
    capabilities: new Set<string>(["docs.edit"]),
  }));
});

test("PUT round-trips — title + revision reflect the update", async () => {
  const res = await PUT(req("PUT", { title: "New" }), {
    params: Promise.resolve({ id: "doc-1" }),
  });
  expect(res.status).toBe(200);
  expect(docs[0].title).toBe("New");
  expect(docs[0].revision).toBe(2);
});

test("DELETE round-trips — doc removed from store", async () => {
  const res = await DELETE(req("DELETE"), {
    params: Promise.resolve({ id: "doc-1" }),
  });
  expect(res.status).toBe(200);
  expect(docs.length).toBe(0);
});
