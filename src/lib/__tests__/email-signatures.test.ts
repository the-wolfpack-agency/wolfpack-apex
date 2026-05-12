 
/**
 * Tests for src/lib/email-signatures.ts.
 *
 * We mock pg's pool.connect for transactional paths (create/update with
 * default-promotion) and mock writeQuery / safeQuery for non-transactional
 * paths (delete, reads).
 */

const mockSafeQuery = jest.fn();
const mockWriteQuery = jest.fn();

const mockClientQuery = jest.fn();
const mockClientRelease = jest.fn();
const mockPoolConnect = jest.fn(async () => ({
  query: mockClientQuery,
  release: mockClientRelease,
}));

jest.mock("@/lib/db", () => {
  const actual = jest.requireActual("@/lib/db");
  return {
    ...actual,
    safeQuery: (...a: any[]) => mockSafeQuery(...a),
    writeQuery: (...a: any[]) => mockWriteQuery(...a),
    pool: {
      connect: () => mockPoolConnect(),
    },
  };
});

import {
  listSignatures,
  getDefaultSignature,
  getSignatureById,
  createSignature,
  updateSignature,
  deleteSignature,
  validateSignatureInput,
  insertSignatureAtCursor,
  insertSignatureAboveQuotedBlock,
} from "@/lib/email-signatures";

const ORIGINAL_DB_URL = process.env.DATABASE_URL;

const dbRow = (override: Partial<Record<string, unknown>> = {}) => ({
  id: "sig-1",
  user_id: "u1",
  label: "Default",
  body: "Nick - CTO",
  body_format: "text",
  is_default: false,
  created_at: "2026-04-30T00:00:00.000Z",
  updated_at: "2026-04-30T00:00:00.000Z",
  ...override,
});

beforeEach(() => {
  mockSafeQuery.mockReset();
  mockWriteQuery.mockReset();
  mockClientQuery.mockReset();
  mockClientRelease.mockReset();
  mockPoolConnect.mockClear();
  process.env.DATABASE_URL = "postgres://test";
});

afterAll(() => {
  if (ORIGINAL_DB_URL === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = ORIGINAL_DB_URL;
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe("validateSignatureInput", () => {
  test("rejects missing label", () => {
    expect(() => validateSignatureInput({ body: "x" })).toThrow(/label is required/);
  });
  test("rejects missing body", () => {
    expect(() => validateSignatureInput({ label: "x" })).toThrow(/body is required/);
  });
  test("rejects empty strings", () => {
    expect(() => validateSignatureInput({ label: "  ", body: "x" })).toThrow(/label is required/);
    expect(() => validateSignatureInput({ label: "x", body: "  " })).toThrow(/body is required/);
  });
  test("trims label/body and defaults bodyFormat to text", () => {
    expect(validateSignatureInput({ label: "  L  ", body: "  B  " })).toEqual({
      label: "L",
      body: "B",
      bodyFormat: "text",
    });
  });
  test("rejects label over 80 chars", () => {
    const long = "a".repeat(81);
    expect(() => validateSignatureInput({ label: long, body: "x" })).toThrow(/label is too long/);
  });
  test("rejects body over 200_000 chars", () => {
    const long = "a".repeat(200_001);
    expect(() => validateSignatureInput({ label: "x", body: long })).toThrow(/body is too long/);
  });
  test("accepts body up to 200_000 chars (HTML signatures with inline images)", () => {
    const long = "a".repeat(150_000);
    expect(validateSignatureInput({ label: "x", body: long }).body.length).toBe(150_000);
  });
  test("accepts bodyFormat='html'", () => {
    expect(
      validateSignatureInput({ label: "L", body: "<p>hi</p>", bodyFormat: "html" }),
    ).toEqual({ label: "L", body: "<p>hi</p>", bodyFormat: "html" });
  });
  test("rejects unknown bodyFormat", () => {
    expect(() =>
      validateSignatureInput({ label: "L", body: "B", bodyFormat: "markdown" }),
    ).toThrow(/bodyFormat must be/);
  });
});

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

describe("listSignatures", () => {
  test("returns empty array when userId is empty", async () => {
    const out = await listSignatures("");
    expect(out).toEqual([]);
    expect(mockSafeQuery).not.toHaveBeenCalled();
  });
  test("maps rows to camelCase signature objects", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [dbRow({ is_default: true }), dbRow({ id: "sig-2", is_default: false })],
      fromCache: false,
    });
    const sigs = await listSignatures("u1");
    expect(sigs).toHaveLength(2);
    expect(sigs[0].id).toBe("sig-1");
    expect(sigs[0].isDefault).toBe(true);
    expect(sigs[0].userId).toBe("u1");
    expect(mockSafeQuery).toHaveBeenCalledWith(
      expect.stringContaining("FROM instinct_email_signatures"),
      ["u1"],
    );
  });
});

describe("getDefaultSignature", () => {
  test("returns null when none", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: false });
    expect(await getDefaultSignature("u1")).toBeNull();
  });
  test("returns mapped row", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [dbRow({ is_default: true })],
      fromCache: false,
    });
    const sig = await getDefaultSignature("u1");
    expect(sig?.isDefault).toBe(true);
  });
});

describe("getSignatureById", () => {
  test("scopes by userId", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [dbRow()], fromCache: false });
    await getSignatureById("sig-1", "u1");
    expect(mockSafeQuery).toHaveBeenCalledWith(
      expect.stringContaining("WHERE id = $1 AND user_id = $2"),
      ["sig-1", "u1"],
    );
  });
});

// ---------------------------------------------------------------------------
// createSignature
// ---------------------------------------------------------------------------

describe("createSignature", () => {
  test("happy path — INSERT inside BEGIN/COMMIT", async () => {
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [dbRow({ is_default: false })] }) // INSERT
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const sig = await createSignature({
      userId: "u1",
      label: "Default",
      body: "Nick",
    });
    expect(sig.id).toBe("sig-1");
    expect(sig.isDefault).toBe(false);

    const calls = mockClientQuery.mock.calls.map((c) => String(c[0]));
    expect(calls[0]).toBe("BEGIN");
    expect(calls[1]).toMatch(/INSERT INTO instinct_email_signatures/);
    expect(calls[2]).toBe("COMMIT");
    expect(mockClientRelease).toHaveBeenCalledTimes(1);
  });

  test("isDefault=true demotes prior defaults atomically before insert", async () => {
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // demote UPDATE
      .mockResolvedValueOnce({ rows: [dbRow({ is_default: true })] }) // INSERT
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const sig = await createSignature({
      userId: "u1",
      label: "Default",
      body: "Nick",
      isDefault: true,
    });
    expect(sig.isDefault).toBe(true);

    const calls = mockClientQuery.mock.calls.map((c) => String(c[0]));
    expect(calls[0]).toBe("BEGIN");
    expect(calls[1]).toMatch(/UPDATE instinct_email_signatures[\s\S]+is_default = FALSE/);
    expect(calls[2]).toMatch(/INSERT INTO instinct_email_signatures/);
    expect(calls[3]).toBe("COMMIT");
  });

  test("rolls back on insert failure", async () => {
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockRejectedValueOnce(new Error("dup key")) // INSERT fails
      .mockResolvedValueOnce({ rows: [] }); // ROLLBACK

    await expect(
      createSignature({ userId: "u1", label: "x", body: "y" }),
    ).rejects.toThrow(/dup key/);
    const last = String(mockClientQuery.mock.calls.at(-1)![0]);
    expect(last).toBe("ROLLBACK");
    expect(mockClientRelease).toHaveBeenCalledTimes(1);
  });

  test("throws WriteQueryError when DATABASE_URL is unset", async () => {
    delete process.env.DATABASE_URL;
    await expect(
      createSignature({ userId: "u1", label: "x", body: "y" }),
    ).rejects.toThrow(/DATABASE_URL/);
  });

  test("validates input before opening a connection", async () => {
    await expect(
      createSignature({ userId: "u1", label: "", body: "y" }),
    ).rejects.toThrow(/label is required/);
    expect(mockPoolConnect).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// updateSignature
// ---------------------------------------------------------------------------

describe("updateSignature", () => {
  test("patches label only — no demote when not promoting", async () => {
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [dbRow({ label: "Renamed" })] }) // UPDATE
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const sig = await updateSignature("sig-1", "u1", { label: "Renamed" });
    expect(sig.label).toBe("Renamed");

    const calls = mockClientQuery.mock.calls.map((c) => String(c[0]));
    expect(calls.filter((c) => /demote|is_default = FALSE/.test(c))).toHaveLength(0);
  });

  test("isDefault=true demotes prior default before updating self", async () => {
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // demote
      .mockResolvedValueOnce({ rows: [dbRow({ is_default: true })] }) // UPDATE self
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const sig = await updateSignature("sig-1", "u1", { isDefault: true });
    expect(sig.isDefault).toBe(true);

    const calls = mockClientQuery.mock.calls.map((c) => String(c[0]));
    expect(calls[1]).toMatch(/is_default = FALSE.*id <> \$2/s);
    expect(calls[2]).toMatch(/SET .*is_default = \$1/);
  });

  test("404 when no rows updated (wrong user_id)", async () => {
    mockClientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // UPDATE — 0 rows
      .mockResolvedValueOnce({ rows: [] }); // ROLLBACK

    await expect(
      updateSignature("sig-1", "wrong-user", { label: "x" }),
    ).rejects.toThrow(/row-count mismatch/);
  });

  test("rejects empty patch", async () => {
    await expect(updateSignature("sig-1", "u1", {})).rejects.toThrow(
      /patch is empty/,
    );
  });
  test("rejects empty label string", async () => {
    await expect(
      updateSignature("sig-1", "u1", { label: "  " }),
    ).rejects.toThrow(/label is required/);
  });
});

// ---------------------------------------------------------------------------
// deleteSignature
// ---------------------------------------------------------------------------

describe("deleteSignature", () => {
  test("returns deleted=true when one row removed", async () => {
    mockWriteQuery.mockResolvedValueOnce({ rows: [dbRow()] });
    const r = await deleteSignature("sig-1", "u1");
    expect(r.deleted).toBe(true);
    expect(mockWriteQuery).toHaveBeenCalledWith(
      expect.stringMatching(/DELETE FROM instinct_email_signatures[\s\S]+WHERE id = \$1 AND user_id = \$2/),
      ["sig-1", "u1"],
    );
  });
  test("returns deleted=false when no row matched (wrong user)", async () => {
    mockWriteQuery.mockResolvedValueOnce({ rows: [] });
    const r = await deleteSignature("sig-1", "other-user");
    expect(r.deleted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Composer helpers
// ---------------------------------------------------------------------------

describe("insertSignatureAtCursor", () => {
  test("appends with two newlines when cursor is null and body is non-empty", () => {
    const out = insertSignatureAtCursor("Hi Jane,\nWhat's up?", null, "Nick — CTO");
    expect(out).toBe("Hi Jane,\nWhat's up?\n\nNick — CTO");
  });
  test("prepends two newlines when body is empty", () => {
    expect(insertSignatureAtCursor("", null, "Nick")).toBe("\n\nNick");
  });
  test("inserts at cursor position", () => {
    const out = insertSignatureAtCursor("Hello | World", 6, "[X]");
    expect(out).toBe("Hello [X]| World");
  });
  test("treats out-of-bounds cursor as append", () => {
    const out = insertSignatureAtCursor("Hi", 999, "Nick");
    expect(out).toBe("Hi\n\nNick");
  });
  test("strips trailing whitespace before appending", () => {
    const out = insertSignatureAtCursor("Hi Jane,\n\n\n", null, "Nick");
    expect(out).toBe("Hi Jane,\n\nNick");
  });
  test("noop on empty signature", () => {
    expect(insertSignatureAtCursor("Hi", null, "  ")).toBe("Hi");
  });
});

describe("insertSignatureAboveQuotedBlock", () => {
  test("inserts above 'On <date>, <name> wrote:' block", () => {
    const body = [
      "Thanks for the update.",
      "",
      "On Apr 30, 2026 at 9:00am, Jane Doe wrote:",
      "> Hi Nick,",
      "> Quick question.",
    ].join("\n");
    const out = insertSignatureAboveQuotedBlock(body, "Nick — CTO");
    /* The signature must come BEFORE the "On ... wrote:" line. */
    const sigPos = out.indexOf("Nick — CTO");
    const quotePos = out.indexOf("On Apr 30");
    expect(sigPos).toBeGreaterThan(-1);
    expect(quotePos).toBeGreaterThan(-1);
    expect(sigPos).toBeLessThan(quotePos);
  });
  test("inserts above 'From: ...' Outlook reply header", () => {
    const body = [
      "Thanks!",
      "",
      "From: Jane Doe <jane@example.com>",
      "Sent: April 30, 2026",
      "Subject: Re: Project",
      "",
      "Original message body...",
    ].join("\n");
    const out = insertSignatureAboveQuotedBlock(body, "Nick");
    const sigPos = out.indexOf("\nNick");
    const headerPos = out.indexOf("From: Jane");
    expect(sigPos).toBeLessThan(headerPos);
  });
  test("inserts above '> '-quoted RFC-style block", () => {
    const body = [
      "My reply text here.",
      "",
      "> Original message",
      "> Second line",
    ].join("\n");
    const out = insertSignatureAboveQuotedBlock(body, "Nick — CTO");
    const sigPos = out.indexOf("Nick — CTO");
    const quotePos = out.indexOf("> Original");
    expect(sigPos).toBeLessThan(quotePos);
  });
  test("falls back to append when no quoted block found", () => {
    const body = "Just a fresh email body.";
    const out = insertSignatureAboveQuotedBlock(body, "Nick");
    expect(out).toBe("Just a fresh email body.\n\nNick");
  });
  test("noop on empty signature", () => {
    expect(insertSignatureAboveQuotedBlock("body", "")).toBe("body");
  });
});
