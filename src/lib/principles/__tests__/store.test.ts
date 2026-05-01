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
