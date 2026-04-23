/**
 * Integration-style test for /api/discussions/[id].
 *
 * Mocks only @/lib/db so updateDiscussion / deleteDiscussion / getThread
 * run real SQL parsing + parameter binding through an in-memory store.
 */

interface Row {
  [k: string]: unknown;
}

const discussions: Row[] = [];
const replies: Row[] = [];

jest.mock("@/lib/db", () => ({
  safeQuery: jest.fn(async (text: string, params: unknown[] = []) => {
    const n = text.replace(/\s+/g, " ").trim();

    // getThread first SELECT (join reply_count).
    if (/SELECT d\.\*, COALESCE\(r\.cnt.*WHERE d\.id = \$1/i.test(n)) {
      const found = discussions.find((d) => d.id === params[0]);
      return { rows: found ? [{ ...found, reply_count: 0 }] : [] };
    }
    // getThread second SELECT (replies).
    if (/SELECT dr\.\*.*WHERE dr\.discussion_id = \$1/i.test(n)) {
      return {
        rows: replies.filter((r) => r.discussion_id === params[0]),
      };
    }
    // updateDiscussion.
    if (/UPDATE instinct_discussions.*SET title/i.test(n)) {
      const idx = discussions.findIndex((d) => d.id === params[0]);
      if (idx === -1) return { rows: [] };
      const fields = ["title", "category", "tags"];
      for (let i = 0; i < fields.length; i++) {
        const p = params[i + 1];
        if (p !== null && p !== undefined) discussions[idx][fields[i]] = p;
      }
      return { rows: [discussions[idx]] };
    }
    // deleteDiscussion — replies purge first.
    if (/DELETE FROM instinct_discussion_replies WHERE discussion_id/i.test(n)) {
      const before = replies.length;
      for (let i = replies.length - 1; i >= 0; i--) {
        if (replies[i].discussion_id === params[0]) replies.splice(i, 1);
      }
      return { rows: [], rowCount: before - replies.length };
    }
    if (/DELETE FROM instinct_discussions WHERE id/i.test(n)) {
      const idx = discussions.findIndex((d) => d.id === params[0]);
      if (idx === -1) return { rows: [] };
      const removed = discussions.splice(idx, 1)[0];
      // The lib now uses DELETE ... RETURNING id, so rows must
      // contain the deleted row's id when the delete hit.
      return { rows: [{ id: removed.id }] };
    }
    return { rows: [] };
  }),
  query: jest.fn(),
  pool: { connect: jest.fn() },
}));

jest.mock("@/lib/audit-log", () => ({
  recordAudit: jest.fn().mockResolvedValue({ id: "a", seq: 1, entryHash: "h" }),
  extractRequestMetadata: () => ({}),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: jest.fn(),
}));
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: jest.fn(),
  hasRole: () => true,
}));
jest.mock("@/lib/auth/require-capability", () => ({
  hasCapability: () => true,
}));

import { NextRequest } from "next/server";
import { PUT, DELETE } from "@/app/api/discussions/[id]/route";
import * as auth from "@/lib/auth";

function req(method: string, body?: unknown): NextRequest {
  return new NextRequest("http://test/api/discussions/d-1", {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  discussions.length = 0;
  replies.length = 0;
  discussions.push({
    id: "d-1",
    title: "Original",
    category: "general",
    created_by: "u-owner",
    status: "open",
    pinned: false,
    tags: [],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  });
  replies.push({
    id: "r-1",
    discussion_id: "d-1",
    author_id: "u-owner",
    content: "hello",
    attachments: [],
    created_at: "2026-01-01T00:00:00Z",
  });
  (auth.getUserFromRequest as jest.Mock).mockReturnValue({
    id: "u-owner",
    role: "dev",
    email: "o@e",
    name: "O",
  });
});

test("PUT round-trips — title reflects new value", async () => {
  const res = await PUT(req("PUT", { title: "New Title" }), {
    params: Promise.resolve({ id: "d-1" }),
  });
  expect(res.status).toBe(200);
  expect(discussions[0].title).toBe("New Title");
});

test("DELETE round-trips — discussion + replies both removed", async () => {
  const res = await DELETE(req("DELETE"), {
    params: Promise.resolve({ id: "d-1" }),
  });
  expect(res.status).toBe(200);
  expect(discussions.length).toBe(0);
  expect(replies.length).toBe(0);
});
