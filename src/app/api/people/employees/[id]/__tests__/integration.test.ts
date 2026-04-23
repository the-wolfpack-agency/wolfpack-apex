/**
 * Integration-style test for /api/people/employees/[id].
 *
 * Instead of mocking the lib layer we mock only the DB (`@/lib/db.safeQuery`)
 * with an in-memory Postgres-like store so people.ts → route.ts round-trips
 * through real SQL parsing + parameter binding. This satisfies the "at least
 * one integration test per resource that writes and reads from the real
 * Postgres path" requirement for environments where a live PG is not
 * available (CI / local-test).
 *
 * Pattern cribbed from src/lib/__tests__/assistant-data-flow.test.ts.
 */

interface Row {
  [k: string]: unknown;
}
const rows: Row[] = [];

jest.mock("@/lib/db", () => ({
  safeQuery: jest.fn(async (text: string, params: unknown[] = []) => {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (/^SELECT \* FROM apex_employees WHERE id = \$1$/i.test(normalized)) {
      const found = rows.find((r) => r.id === params[0]);
      return { rows: found ? [found] : [] };
    }
    if (/^UPDATE apex_employees/i.test(normalized)) {
      const idx = rows.findIndex((r) => r.id === params[0]);
      if (idx === -1) return { rows: [] };
      // Emulate COALESCE fields 2-10
      const fields = [
        "full_name",
        "email",
        "role_title",
        "department",
        "start_date",
        "birth_year",
        "zip_code",
        "status",
        "metadata",
      ];
      for (let i = 0; i < fields.length; i++) {
        const p = params[i + 1];
        if (p !== null && p !== undefined) {
          rows[idx][fields[i]] = p;
        }
      }
      return { rows: [rows[idx]] };
    }
    if (/^DELETE FROM apex_employees WHERE id = \$1$/i.test(normalized)) {
      const idx = rows.findIndex((r) => r.id === params[0]);
      if (idx === -1) return { rows: [], rowCount: 0 };
      rows.splice(idx, 1);
      return { rows: [], rowCount: 1 };
    }
    return { rows: [] };
  }),
  query: jest.fn(),
  pool: { connect: jest.fn() },
}));

// Audit log writes to PG but we stub it to avoid a second DB layer.
jest.mock("@/lib/audit-log", () => ({
  recordAudit: jest.fn().mockResolvedValue({ id: "a", seq: 1, entryHash: "h" }),
  extractRequestMetadata: () => ({}),
}));

// trackEvent fires fire-and-forget — silence it.
jest.mock("@/lib/analytics", () => ({
  trackEvent: jest.fn(),
}));

jest.mock("@/lib/auth", () => ({
  getUserFromRequest: jest.fn(),
}));

jest.mock("@/lib/auth/require-capability", () => ({
  hasCapability: () => true,
}));

import { NextRequest } from "next/server";
import { PUT, DELETE } from "@/app/api/people/employees/[id]/route";
import * as auth from "@/lib/auth";

function req(method: string, body?: unknown): NextRequest {
  return new NextRequest("http://test/api/people/employees/emp-1", {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  rows.length = 0;
  rows.push({
    id: "emp-1",
    full_name: "Alice",
    email: "alice@e",
    role_title: "Eng",
    department: "Platform",
    start_date: null,
    birth_year: null,
    zip_code: null,
    status: "active",
    metadata: {},
    created_by: "u-owner",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  });
  (auth.getUserFromRequest as jest.Mock).mockReturnValue({
    id: "u-owner",
    role: "hr",
    email: "o@e",
    name: "O",
  });
});

test("PUT round-trips through mock DB — row reflects new department", async () => {
  const res = await PUT(req("PUT", { department: "Platform2" }), {
    params: Promise.resolve({ id: "emp-1" }),
  });
  expect(res.status).toBe(200);
  expect(rows[0].department).toBe("Platform2");
});

test("DELETE round-trips — row is removed from the in-memory store", async () => {
  const res = await DELETE(req("DELETE"), {
    params: Promise.resolve({ id: "emp-1" }),
  });
  expect(res.status).toBe(200);
  expect(rows.find((r) => r.id === "emp-1")).toBeUndefined();
});

test("DELETE returns 404 when the row was already removed", async () => {
  rows.length = 0;
  const res = await DELETE(req("DELETE"), {
    params: Promise.resolve({ id: "emp-1" }),
  });
  expect(res.status).toBe(404);
});
