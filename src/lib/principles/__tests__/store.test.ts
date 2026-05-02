/* eslint-disable @typescript-eslint/no-explicit-any */
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
    pool: { connect: () => mockPoolConnect() },
  };
});

import {
  listActivePrinciples,
  getActivePrincipleBySlug,
  syncPrinciplesFromParsed,
  recordDocVersion,
  getLatestDocVersion,
  createPrincipleNative,
  patchPrincipleNative,
  retirePrincipleNative,
  insertObservations,
} from "@/lib/principles/store";
import type { ParsedPrinciple } from "@/lib/principles/parser";

const ORIGINAL_DB_URL = process.env.DATABASE_URL;

beforeEach(() => {
  mockSafeQuery.mockReset();
  mockWriteQuery.mockReset();
  mockClientQuery.mockReset();
  mockClientRelease.mockReset();
  mockPoolConnect.mockClear();
  process.env.DATABASE_URL = "postgres://test";
});

afterAll(() => {
  if (ORIGINAL_DB_URL) process.env.DATABASE_URL = ORIGINAL_DB_URL;
  else delete process.env.DATABASE_URL;
});

const principleRow = (override: Record<string, unknown> = {}) => ({
  id: "p1",
  slug: "ship-before-perfect",
  title: "Ship before perfect",
  domains: ["code"],
  owner: "Hoxsie",
  body_md: "body",
  scoreboard_weight: 3,
  source_url: "sp://doc",
  source_doc_hash: "h1",
  effective_at: "2026-05-01",
  retired_at: null,
  created_at: "2026-05-01T00:00:00Z",
  updated_at: "2026-05-01T00:00:00Z",
  ...override,
});

const parsedPrinciple = (override: Partial<ParsedPrinciple> = {}): ParsedPrinciple => ({
  slug: "ship-before-perfect",
  title: "Ship before perfect",
  domains: ["code"],
  owner: "Hoxsie",
  effectiveAt: "2026-05-01",
  scoreboardWeight: 3,
  bodyMd: "body",
  signals: ["PR cycle time < 48h"],
  counterSignals: [],
  ...override,
});

describe("listActivePrinciples", () => {
  test("returns mapped, weight-ordered records", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [principleRow(), principleRow({ id: "p2", slug: "second", title: "Second", scoreboard_weight: 2 })],
    });
    const out = await listActivePrinciples();
    expect(out).toHaveLength(2);
    expect(out[0].slug).toBe("ship-before-perfect");
    expect(out[0].scoreboardWeight).toBe(3);
  });
});

describe("getActivePrincipleBySlug", () => {
  test("empty slug short-circuits to null", async () => {
    expect(await getActivePrincipleBySlug("")).toBeNull();
    expect(mockSafeQuery).not.toHaveBeenCalled();
  });
  test("returns null when no row", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [] });
    expect(await getActivePrincipleBySlug("missing")).toBeNull();
  });
});

describe("syncPrinciplesFromParsed", () => {
  test("rejects when DATABASE_URL is unset", async () => {
    delete process.env.DATABASE_URL;
    await expect(
      syncPrinciplesFromParsed({
        parsed: [],
        sourceUrl: "sp://doc",
        sourceDocHash: "h1",
      }),
    ).rejects.toThrow(/DATABASE_URL/);
  });

  test("inserts new principle when slug doesn't exist; signals fan out", async () => {
    /* Step 1: BEGIN. Step 2: load active. Step 3: insert principle. Step 4: insert signal. Step 5: COMMIT. */
    mockClientQuery
      .mockResolvedValueOnce(undefined as any) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // active load — empty
      .mockResolvedValueOnce({ rows: [principleRow()] }) // INSERT principle
      .mockResolvedValueOnce(undefined as any) // INSERT signal
      .mockResolvedValueOnce(undefined as any); // COMMIT

    const out = await syncPrinciplesFromParsed({
      parsed: [parsedPrinciple()],
      sourceUrl: "sp://doc",
      sourceDocHash: "h1",
    });
    expect(out.inserted).toHaveLength(1);
    expect(out.unchanged).toEqual([]);
    expect(out.retired).toEqual([]);

    /* Verify the SQL contract surface — INSERT principle + INSERT signal ran. */
    const allSql = mockClientQuery.mock.calls.map((c) => String(c[0])).join(" | ");
    expect(allSql).toMatch(/INSERT INTO instinct_principles/);
    expect(allSql).toMatch(/INSERT INTO instinct_principle_signals/);
  });

  test("treats matching hash as unchanged — no write churn", async () => {
    mockClientQuery
      .mockResolvedValueOnce(undefined as any) // BEGIN
      .mockResolvedValueOnce({ rows: [principleRow({ source_doc_hash: "h1" })] }) // active
      .mockResolvedValueOnce(undefined as any); // COMMIT

    const out = await syncPrinciplesFromParsed({
      parsed: [parsedPrinciple()],
      sourceUrl: "sp://doc",
      sourceDocHash: "h1",
    });
    expect(out.unchanged).toHaveLength(1);
    expect(out.inserted).toEqual([]);
    expect(out.retired).toEqual([]);
  });

  test("retires + replaces when hash differs", async () => {
    mockClientQuery
      .mockResolvedValueOnce(undefined as any) // BEGIN
      .mockResolvedValueOnce({ rows: [principleRow({ source_doc_hash: "OLD" })] }) // active
      .mockResolvedValueOnce(undefined as any) // UPDATE retired_at on prior
      .mockResolvedValueOnce({ rows: [principleRow({ id: "p2", source_doc_hash: "NEW" })] }) // INSERT new
      .mockResolvedValueOnce(undefined as any) // INSERT signal
      .mockResolvedValueOnce(undefined as any); // COMMIT

    const out = await syncPrinciplesFromParsed({
      parsed: [parsedPrinciple()],
      sourceUrl: "sp://doc",
      sourceDocHash: "NEW",
    });
    expect(out.inserted.map((p) => p.id)).toEqual(["p2"]);
  });

  test("retires principles whose slug disappeared from the doc", async () => {
    mockClientQuery
      .mockResolvedValueOnce(undefined as any) // BEGIN
      .mockResolvedValueOnce({ rows: [principleRow({ slug: "abandoned" })] }) // active
      .mockResolvedValueOnce(undefined as any) // UPDATE retired_at
      .mockResolvedValueOnce(undefined as any); // COMMIT

    const out = await syncPrinciplesFromParsed({
      parsed: [],
      sourceUrl: "sp://doc",
      sourceDocHash: "anything",
    });
    expect(out.retired).toHaveLength(1);
    expect(out.retired[0].slug).toBe("abandoned");
    expect(out.inserted).toEqual([]);
  });

  test("rolls back transaction when an INSERT fails", async () => {
    mockClientQuery
      .mockResolvedValueOnce(undefined as any) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // active
      .mockRejectedValueOnce(new Error("constraint violated")); // INSERT principle throws
    await expect(
      syncPrinciplesFromParsed({
        parsed: [parsedPrinciple()],
        sourceUrl: "sp://doc",
        sourceDocHash: "h",
      }),
    ).rejects.toThrow(/constraint/);
    /* ROLLBACK was attempted + connection released. */
    const allSql = mockClientQuery.mock.calls.map((c) => String(c[0]));
    expect(allSql).toContain("ROLLBACK");
    expect(mockClientRelease).toHaveBeenCalled();
  });
});

describe("createPrincipleNative", () => {
  test("rejects when DATABASE_URL is unset", async () => {
    delete process.env.DATABASE_URL;
    await expect(
      createPrincipleNative({
        title: "X",
        domains: [],
        owner: null,
        bodyMd: "",
        scoreboardWeight: 1,
        effectiveAt: null,
        signals: [],
        counterSignals: [],
      }),
    ).rejects.toThrow(/DATABASE_URL/);
  });

  test("rejects empty title", async () => {
    await expect(
      createPrincipleNative({
        title: "   ",
        domains: [],
        owner: null,
        bodyMd: "",
        scoreboardWeight: 1,
        effectiveAt: null,
        signals: [],
        counterSignals: [],
      }),
    ).rejects.toThrow(/title required/);
  });

  test("inserts row + signals + counter-signals; returns mapped record", async () => {
    mockClientQuery
      .mockResolvedValueOnce(undefined as any) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // dup check
      .mockResolvedValueOnce({ rows: [principleRow()] }) // INSERT principle
      .mockResolvedValueOnce(undefined as any) // INSERT signal
      .mockResolvedValueOnce(undefined as any) // INSERT counter
      .mockResolvedValueOnce(undefined as any); // COMMIT

    const out = await createPrincipleNative({
      title: "Ship before perfect",
      domains: ["code"],
      owner: "Hoxsie",
      bodyMd: "body",
      scoreboardWeight: 3,
      effectiveAt: "2026-05-01",
      signals: ["PR cycle time < 48h"],
      counterSignals: ["weekend pushes"],
    });
    expect(out.slug).toBe("ship-before-perfect");
    const sql = mockClientQuery.mock.calls.map((c) => String(c[0]));
    expect(sql.some((s) => /INSERT INTO instinct_principles/.test(s))).toBe(true);
    expect(sql.filter((s) => /INSERT INTO instinct_principle_signals/.test(s))).toHaveLength(2);
  });

  test("rejects duplicate active slug", async () => {
    mockClientQuery
      .mockResolvedValueOnce(undefined as any) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: "existing" }] }); // dup check hits

    await expect(
      createPrincipleNative({
        title: "Ship before perfect",
        domains: [],
        owner: null,
        bodyMd: "",
        scoreboardWeight: 1,
        effectiveAt: null,
        signals: [],
        counterSignals: [],
      }),
    ).rejects.toThrow(/already exists/);
    const sql = mockClientQuery.mock.calls.map((c) => String(c[0]));
    expect(sql).toContain("ROLLBACK");
  });
});

describe("patchPrincipleNative", () => {
  test("rejects when no id", async () => {
    await expect(
      patchPrincipleNative({ id: "" }),
    ).rejects.toThrow(/id required/);
  });

  test("partial update: only sets the columns provided", async () => {
    mockClientQuery
      .mockResolvedValueOnce(undefined as any) // BEGIN
      .mockResolvedValueOnce({ rows: [principleRow({ title: "New title" })] }) // UPDATE returning
      .mockResolvedValueOnce(undefined as any); // COMMIT

    const out = await patchPrincipleNative({ id: "p1", bodyMd: "fresh body" });
    expect(out.id).toBe("p1");
    const updateCall = mockClientQuery.mock.calls.find((c) =>
      /UPDATE instinct_principles/.test(String(c[0])),
    );
    expect(updateCall).toBeDefined();
    expect(String(updateCall![0])).toMatch(/body_md = \$1/);
    /* No DELETE on signals because signals was untouched. */
    const sql = mockClientQuery.mock.calls.map((c) => String(c[0]));
    expect(sql.some((s) => /DELETE FROM instinct_principle_signals/.test(s))).toBe(false);
  });

  test("title change re-derives slug + checks uniqueness", async () => {
    mockClientQuery
      .mockResolvedValueOnce(undefined as any) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // slug uniqueness check
      .mockResolvedValueOnce({ rows: [principleRow({ title: "Renamed" })] }) // UPDATE
      .mockResolvedValueOnce(undefined as any); // COMMIT

    const out = await patchPrincipleNative({ id: "p1", title: "Renamed" });
    expect(out).toBeDefined();
    const sql = mockClientQuery.mock.calls.map((c) => String(c[0]));
    expect(sql.some((s) => /slug = \$1 AND retired_at IS NULL AND id <> \$2/.test(s))).toBe(true);
    expect(sql.some((s) => /UPDATE instinct_principles[\s\S]*slug = /.test(s))).toBe(true);
  });

  test("title rename hitting a different active slug rolls back", async () => {
    mockClientQuery
      .mockResolvedValueOnce(undefined as any) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: "other" }] }); // dup hit

    await expect(
      patchPrincipleNative({ id: "p1", title: "Conflicts" }),
    ).rejects.toThrow(/already exists/);
    const sql = mockClientQuery.mock.calls.map((c) => String(c[0]));
    expect(sql).toContain("ROLLBACK");
  });

  test("signals replace: deletes old + inserts new", async () => {
    mockClientQuery
      .mockResolvedValueOnce(undefined as any) // BEGIN
      .mockResolvedValueOnce({ rows: [principleRow()] }) // SELECT (no field updates → load row)
      .mockResolvedValueOnce(undefined as any) // DELETE signals
      .mockResolvedValueOnce(undefined as any) // INSERT signal
      .mockResolvedValueOnce(undefined as any) // INSERT counter
      .mockResolvedValueOnce(undefined as any); // COMMIT

    await patchPrincipleNative({
      id: "p1",
      signals: ["s1"],
      counterSignals: ["c1"],
    });
    const sql = mockClientQuery.mock.calls.map((c) => String(c[0]));
    expect(sql.some((s) => /DELETE FROM instinct_principle_signals/.test(s))).toBe(true);
    expect(sql.filter((s) => /INSERT INTO instinct_principle_signals/.test(s))).toHaveLength(2);
  });

  test("rejects when row already retired", async () => {
    mockClientQuery
      .mockResolvedValueOnce(undefined as any) // BEGIN
      .mockResolvedValueOnce({ rows: [] }); // UPDATE returns 0 rows

    await expect(
      patchPrincipleNative({ id: "gone", bodyMd: "x" }),
    ).rejects.toThrow(/not found or already retired/);
  });
});

describe("retirePrincipleNative", () => {
  test("rejects when no id", async () => {
    await expect(retirePrincipleNative("")).rejects.toThrow(/id required/);
  });

  test("rejects when DATABASE_URL is unset", async () => {
    delete process.env.DATABASE_URL;
    await expect(retirePrincipleNative("p1")).rejects.toThrow(/DATABASE_URL/);
  });

  test("issues UPDATE with retired_at = NOW() filtered to active row", async () => {
    mockWriteQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    await retirePrincipleNative("p1");
    expect(mockWriteQuery).toHaveBeenCalledTimes(1);
    expect(String(mockWriteQuery.mock.calls[0][0])).toMatch(
      /UPDATE instinct_principles[\s\S]*retired_at = NOW\(\)[\s\S]*retired_at IS NULL/,
    );
    expect(mockWriteQuery.mock.calls[0][1]).toEqual(["p1"]);
  });
});

describe("insertObservations", () => {
  test("persists observed_at per row from the validator's payload", async () => {
    mockWriteQuery.mockResolvedValueOnce({ rows: [], rowCount: 2 });
    await insertObservations({
      principleId: "p1",
      signalId: "s1",
      validatorId: "mail.after_hours",
      rows: [
        {
          surface: "mail",
          subjectUserId: "u-a",
          observedAt: "2026-04-30T23:55:00Z",
          score: -0.6,
          evidenceJsonb: { kind: "x" },
        },
        {
          surface: "mail",
          subjectUserId: "u-b",
          observedAt: "2026-05-01T02:10:00Z",
          score: -0.6,
          evidenceJsonb: { kind: "x" },
        },
      ],
    });
    /* INSERT must list observed_at as a column AND the params must
       carry the per-row send timestamps — not NOW() at the DB. */
    const sql = String(mockWriteQuery.mock.calls[0][0]);
    expect(sql).toMatch(/observed_at/);
    const params = mockWriteQuery.mock.calls[0][1] as unknown[];
    expect(params).toContain("2026-04-30T23:55:00Z");
    expect(params).toContain("2026-05-01T02:10:00Z");
  });

  test("collapses duplicate input rows by natural key before INSERT", async () => {
    /* Two identical rollup rows in one call (e.g. multiple signal lines
       on the same principle binding to the same validator) must
       collapse to a single INSERT. Determinism on observed_at comes
       from the validator side (snapToUtcDay) — duplicates that reach
       this layer share the same observed_at exactly. The SQL must end
       with ON CONFLICT DO NOTHING so cross-call dupes also no-op. */
    mockWriteQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    await insertObservations({
      principleId: "p1",
      signalId: "s1",
      validatorId: "calendar.focus_block_ratio",
      rows: [
        {
          surface: "calendar",
          surfaceSubtype: "focus_block_ratio",
          subjectUserId: "u-a",
          observedAt: "2026-05-01T00:00:00.000Z",
          score: 0.5,
          evidenceJsonb: { kind: "rollup" },
        },
        {
          surface: "calendar",
          surfaceSubtype: "focus_block_ratio",
          subjectUserId: "u-a",
          observedAt: "2026-05-01T00:00:00.000Z",
          score: 0.5,
          evidenceJsonb: { kind: "rollup" },
        },
      ],
    });
    const sql = String(mockWriteQuery.mock.calls[0][0]);
    expect(sql).toMatch(/ON CONFLICT DO NOTHING/);
    /* Only ONE placeholder row in VALUES (9 params). */
    const params = mockWriteQuery.mock.calls[0][1] as unknown[];
    expect(params.length).toBe(9);
  });

  test("rows with distinct sourceIds are NOT collapsed (per-event observations stay distinct)", async () => {
    mockWriteQuery.mockResolvedValueOnce({ rows: [], rowCount: 2 });
    await insertObservations({
      principleId: "p1",
      signalId: "s1",
      validatorId: "mail.after_hours_send",
      rows: [
        {
          surface: "mail",
          subjectUserId: "u-a",
          observedAt: "2026-05-01T22:00:00Z",
          score: -0.6,
          evidenceJsonb: { sourceId: "msg-1" },
        },
        {
          surface: "mail",
          subjectUserId: "u-a",
          observedAt: "2026-05-01T22:00:30Z",
          score: -0.6,
          evidenceJsonb: { sourceId: "msg-2" },
        },
      ],
    });
    const params = mockWriteQuery.mock.calls[0][1] as unknown[];
    expect(params.length).toBe(18); // 2 rows × 9 params each
  });

  test("falls back to current ISO when validator omits observedAt", async () => {
    mockWriteQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    await insertObservations({
      principleId: "p1",
      signalId: "s1",
      validatorId: "v1",
      rows: [
        {
          surface: "mail",
          observedAt: "",
          score: 0,
          evidenceJsonb: {},
        },
      ],
    });
    const params = mockWriteQuery.mock.calls[0][1] as unknown[];
    /* Slot index 6 in our INSERT (0=principleId,1=signalId,2=validatorId,
       3=surface, 4=subtype, 5=subjectUserId, 6=observedAt) — exact
       value is "now-ish" so just assert the format. */
    const observedAt = params[6];
    expect(typeof observedAt).toBe("string");
    expect(observedAt as string).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("doc version history", () => {
  test("getLatestDocVersion returns null when no rows", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [] });
    expect(await getLatestDocVersion("sp://doc")).toBeNull();
  });
  test("recordDocVersion stringifies warnings + maps result", async () => {
    mockWriteQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "v1",
          source_url: "sp://doc",
          doc_hash: "h",
          fetched_at: "2026-05-01T00:00:00Z",
          parsed_principle_count: 3,
          parse_warnings_jsonb: ["warning a"],
          triggered_by: "cron",
        },
      ],
    });
    const out = await recordDocVersion({
      sourceUrl: "sp://doc",
      docHash: "h",
      parsedPrincipleCount: 3,
      parseWarnings: ["warning a"],
      triggeredBy: "cron",
    });
    expect(out.parseWarnings).toEqual(["warning a"]);
    expect(mockWriteQuery.mock.calls[0][1]).toEqual([
      "sp://doc",
      "h",
      3,
      JSON.stringify(["warning a"]),
      "cron",
    ]);
  });
});
