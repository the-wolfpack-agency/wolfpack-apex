/**
 * support/repo — unit tests.
 *
 * Mocks @/lib/db, @/lib/qdrant, @/lib/neo4j so we can drive every
 * helper without infrastructure. Verifies:
 *   - createTicket inserts and fires triple-write hooks
 *   - listTickets builds the right WHERE + clamps the limit + treats
 *     status="all" as no filter
 *   - getTicket null path
 *   - updateTicket no-op short-circuit + array_uuid casting
 *   - deleteTicket boolean return
 *   - recordFeedback updates the ticket, increments the right pattern
 *     counter, and records a (:RATED) edge per pattern
 *   - listEnabledPatterns + getPatternBySlug + upsertSeedPattern
 *   - triple-write side-effects throwing don't bubble up
 */

const mockQuery = jest.fn();
const mockWriteQuery = jest.fn();
jest.mock("@/lib/db", () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  writeQuery: (...args: unknown[]) => mockWriteQuery(...args),
  WriteQueryError: class extends Error {},
}));

const mockUpsert = jest.fn();
jest.mock("@/lib/qdrant", () => ({
  upsertKnowledgePoint: (...args: unknown[]) => mockUpsert(...args),
}));

const mockCypher = jest.fn();
jest.mock("@/lib/neo4j", () => ({
  executeCypher: (...args: unknown[]) => mockCypher(...args),
}));

import {
  createTicket,
  getTicket,
  listTickets,
  updateTicket,
  deleteTicket,
  recordFeedback,
  listEnabledPatterns,
  getPatternBySlug,
  upsertSeedPattern,
} from "@/lib/support/repo";
import { SEED_PATTERNS } from "@/lib/support/seed-patterns";

const baseTicketRow = {
  id: "tk-1",
  title: "Cannot sign in",
  body: "AADSTS20012",
  diagnostic_text: "log id 1",
  category: "auth",
  severity: "p2",
  status: "open",
  created_by_user_id: "user-1",
  created_by_email: "alicia@x",
  draft_response: null,
  draft_generated_at: null,
  draft_pattern_ids: [],
  sent_response: null,
  sent_at: null,
  sent_to_email: null,
  helpful: null,
  edit_diff: null,
  feedback_notes: null,
  feedback_at: null,
  created_at: "2026-04-27T00:00:00.000Z",
  updated_at: "2026-04-27T00:00:00.000Z",
};

const basePatternRow = {
  id: "p-1",
  slug: "aadsts20012-ws-fed",
  name: "AADSTS20012",
  category: "auth",
  match_signatures: [{ type: "regex", pattern: "AADSTS20012" }],
  draft_template: "Hi {{first_name}}, ...",
  success_count: 0,
  fail_count: 0,
  enabled: true,
  created_at: "2026-04-27T00:00:00.000Z",
  updated_at: "2026-04-27T00:00:00.000Z",
};

let consoleWarnSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
  mockUpsert.mockResolvedValue(undefined);
  mockCypher.mockResolvedValue([]);
});

afterEach(() => {
  consoleWarnSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// createTicket
// ---------------------------------------------------------------------------
describe("createTicket", () => {
  it("inserts a row and fires Qdrant + Neo4j triple-writes", async () => {
    mockWriteQuery.mockResolvedValueOnce({ rows: [baseTicketRow] });

    const out = await createTicket({
      title: "Cannot sign in",
      body: "AADSTS20012",
      diagnostic_text: "log id 1",
      category: "auth",
      severity: "p2",
      status: "open",
      created_by_user_id: "user-1",
      created_by_email: "alicia@x",
    });

    expect(out.id).toBe("tk-1");
    const [sql, params, opts] = mockWriteQuery.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO instinct_support_tickets/);
    expect(params).toEqual([
      "Cannot sign in",
      "AADSTS20012",
      "log id 1",
      "auth",
      "p2",
      "open",
      "user-1",
      "alicia@x",
    ]);
    expect(opts).toEqual({ expectRows: 1 });
    expect(mockUpsert).toHaveBeenCalledWith(
      "support-ticket:tk-1",
      expect.stringContaining("AADSTS20012"),
      "",
      "support",
      ["support-ticket", "auth", "p2"],
    );
    expect(mockCypher).toHaveBeenCalled();
    const [cypher, vars] = mockCypher.mock.calls[0];
    expect(cypher).toMatch(/MERGE \(o:Operator/);
    expect(vars).toMatchObject({ user_id: "user-1", id: "tk-1" });
  });

  it("propagates writeQuery errors (no silent loss)", async () => {
    mockWriteQuery.mockRejectedValueOnce(new Error("pg down"));
    await expect(
      createTicket({
        title: "t",
        body: "b",
        created_by_user_id: "user-1",
      }),
    ).rejects.toThrow(/pg down/);
  });

  it("does not throw when Qdrant is offline", async () => {
    mockWriteQuery.mockResolvedValueOnce({ rows: [baseTicketRow] });
    mockUpsert.mockRejectedValueOnce(new Error("qdrant down"));
    const out = await createTicket({
      title: "t",
      body: "b",
      created_by_user_id: "user-1",
    });
    expect(out.id).toBe("tk-1");
    expect(consoleWarnSpy).toHaveBeenCalled();
  });

  it("does not throw when Neo4j is offline", async () => {
    mockWriteQuery.mockResolvedValueOnce({ rows: [baseTicketRow] });
    mockCypher.mockRejectedValueOnce(new Error("neo4j down"));
    const out = await createTicket({
      title: "t",
      body: "b",
      created_by_user_id: "user-1",
    });
    expect(out.id).toBe("tk-1");
  });
});

// ---------------------------------------------------------------------------
// listTickets
// ---------------------------------------------------------------------------
describe("listTickets", () => {
  it("returns rows mapped to typed tickets when no filters", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [baseTicketRow] });
    const out = await listTickets();
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("tk-1");
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).not.toMatch(/WHERE/);
    expect(params).toEqual([]);
    expect(sql).toMatch(/LIMIT 100/);
  });

  it("filters by status when provided", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await listTickets({ status: "drafted" });
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/WHERE status = \$1/);
    expect(params).toEqual(["drafted"]);
  });

  it("treats status='all' as no filter", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await listTickets({ status: "all" });
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).not.toMatch(/WHERE/);
    expect(params).toEqual([]);
  });

  it("filters by category alongside status", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await listTickets({ status: "open", category: "auth" });
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/WHERE status = \$1 AND category = \$2/);
    expect(params).toEqual(["open", "auth"]);
  });

  it("clamps absurd limits", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await listTickets({ limit: 99999 });
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/LIMIT 500/);
  });
});

// ---------------------------------------------------------------------------
// getTicket / updateTicket / deleteTicket
// ---------------------------------------------------------------------------
describe("getTicket", () => {
  it("returns null when missing", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const out = await getTicket("missing");
    expect(out).toBeNull();
  });

  it("returns the ticket when present", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [baseTicketRow] });
    const out = await getTicket("tk-1");
    expect(out?.id).toBe("tk-1");
  });
});

describe("updateTicket", () => {
  it("returns the existing row without UPDATE when patch is empty", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [baseTicketRow] });
    const out = await updateTicket("tk-1", {});
    expect(out?.id).toBe("tk-1");
    expect(mockWriteQuery).not.toHaveBeenCalled();
  });

  it("issues an UPDATE with patchable fields and returns the new row", async () => {
    mockWriteQuery.mockResolvedValueOnce({
      rows: [{ ...baseTicketRow, status: "drafted", draft_response: "Hello" }],
    });
    const out = await updateTicket("tk-1", {
      status: "drafted",
      draft_response: "Hello",
    });
    expect(out?.status).toBe("drafted");
    const [sql, params] = mockWriteQuery.mock.calls[0];
    expect(sql).toMatch(/UPDATE instinct_support_tickets/);
    expect(sql).toMatch(/status = \$1/);
    expect(sql).toMatch(/draft_response = \$2/);
    expect(sql).toMatch(/updated_at = NOW\(\)/);
    expect(params).toEqual(["drafted", "Hello", "tk-1"]);
  });

  it("casts draft_pattern_ids to uuid[] and fires Neo4j MATCHED edges", async () => {
    mockWriteQuery.mockResolvedValueOnce({
      rows: [
        {
          ...baseTicketRow,
          status: "drafted",
          draft_pattern_ids: ["p-1", "p-2"],
        },
      ],
    });
    await updateTicket("tk-1", {
      status: "drafted",
      draft_pattern_ids: ["p-1", "p-2"],
    });
    const [sql] = mockWriteQuery.mock.calls[0];
    expect(sql).toMatch(/draft_pattern_ids = \$\d+::uuid\[\]/);
    const matchedCalls = mockCypher.mock.calls.filter((c) =>
      String(c[0]).includes("MATCHED"),
    );
    expect(matchedCalls).toHaveLength(2);
  });

  it("fires Neo4j sent_at update when sent_at is in the patch", async () => {
    mockWriteQuery.mockResolvedValueOnce({
      rows: [
        {
          ...baseTicketRow,
          status: "sent",
          sent_at: "2026-04-27T01:00:00.000Z",
        },
      ],
    });
    await updateTicket("tk-1", {
      status: "sent",
      sent_at: "2026-04-27T01:00:00.000Z",
    });
    const sentCalls = mockCypher.mock.calls.filter((c) =>
      String(c[0]).includes("sent_at"),
    );
    expect(sentCalls.length).toBeGreaterThan(0);
  });

  it("ignores unknown fields silently", async () => {
    mockWriteQuery.mockResolvedValueOnce({ rows: [baseTicketRow] });
    await updateTicket("tk-1", {
      title: "renamed",
      somethingElse: "ignored",
    } as Record<string, unknown>);
    const [sql, params] = mockWriteQuery.mock.calls[0];
    expect(sql).toMatch(/title = \$1/);
    expect(sql).not.toMatch(/somethingElse/);
    expect(params).toEqual(["renamed", "tk-1"]);
  });

  it("returns null when the row was not found", async () => {
    mockWriteQuery.mockResolvedValueOnce({ rows: [] });
    const out = await updateTicket("missing", { title: "x" });
    expect(out).toBeNull();
  });
});

describe("deleteTicket", () => {
  it("returns true when a row was removed", async () => {
    mockWriteQuery.mockResolvedValueOnce({ rows: [{ id: "tk-1" }] });
    expect(await deleteTicket("tk-1")).toBe(true);
  });

  it("returns false when nothing was removed", async () => {
    mockWriteQuery.mockResolvedValueOnce({ rows: [] });
    expect(await deleteTicket("tk-1")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// recordFeedback
// ---------------------------------------------------------------------------
describe("recordFeedback", () => {
  it("updates the ticket, increments success_count for helpful=true, and records :RATED edges", async () => {
    mockWriteQuery
      .mockResolvedValueOnce({
        rows: [
          {
            ...baseTicketRow,
            helpful: true,
            feedback_notes: "Worked great",
            feedback_at: "2026-04-27T02:00:00.000Z",
            draft_pattern_ids: ["p-1", "p-2"],
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ id: "p-1" }] })
      .mockResolvedValueOnce({ rows: [{ id: "p-2" }] });

    const out = await recordFeedback("tk-1", {
      helpful: true,
      notes: "Worked great",
    });

    expect(out?.helpful).toBe(true);
    const [updateSql, updateParams] = mockWriteQuery.mock.calls[0];
    expect(updateSql).toMatch(/UPDATE instinct_support_tickets/);
    expect(updateParams).toEqual(["tk-1", true, null, "Worked great"]);

    const counterCalls = mockWriteQuery.mock.calls.slice(1);
    expect(counterCalls).toHaveLength(2);
    for (const c of counterCalls) {
      expect(c[0]).toMatch(/success_count = success_count \+ 1/);
    }

    const ratedCalls = mockCypher.mock.calls.filter((c) =>
      String(c[0]).includes("RATED"),
    );
    expect(ratedCalls).toHaveLength(2);
  });

  it("increments fail_count when helpful=false", async () => {
    mockWriteQuery
      .mockResolvedValueOnce({
        rows: [
          {
            ...baseTicketRow,
            helpful: false,
            draft_pattern_ids: ["p-1"],
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ id: "p-1" }] });

    await recordFeedback("tk-1", { helpful: false });
    const [counterSql] = mockWriteQuery.mock.calls[1];
    expect(counterSql).toMatch(/fail_count = fail_count \+ 1/);
  });

  it("returns null when the ticket id is unknown", async () => {
    mockWriteQuery.mockResolvedValueOnce({ rows: [] });
    const out = await recordFeedback("missing", { helpful: true });
    expect(out).toBeNull();
  });

  it("serializes edit_diff as JSON when provided", async () => {
    mockWriteQuery.mockResolvedValueOnce({
      rows: [{ ...baseTicketRow, draft_pattern_ids: [] }],
    });
    await recordFeedback("tk-1", {
      helpful: true,
      edit_diff: { added: ["clarification"] },
    });
    const [, updateParams] = mockWriteQuery.mock.calls[0];
    expect(updateParams[2]).toBe(JSON.stringify({ added: ["clarification"] }));
  });

  it("does not bubble up pattern-counter failures", async () => {
    mockWriteQuery
      .mockResolvedValueOnce({
        rows: [
          {
            ...baseTicketRow,
            helpful: true,
            draft_pattern_ids: ["p-1"],
          },
        ],
      })
      .mockRejectedValueOnce(new Error("counter row missing"));

    const out = await recordFeedback("tk-1", { helpful: true });
    expect(out?.helpful).toBe(true);
    expect(consoleWarnSpy).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// pattern helpers
// ---------------------------------------------------------------------------
describe("listEnabledPatterns", () => {
  it("returns rows ordered by net feedback then slug", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [basePatternRow] });
    const out = await listEnabledPatterns();
    expect(out).toHaveLength(1);
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/WHERE enabled = TRUE/);
    expect(sql).toMatch(/ORDER BY \(success_count - fail_count\) DESC, slug ASC/);
  });
});

describe("getPatternBySlug", () => {
  it("returns null when missing", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await getPatternBySlug("nope")).toBeNull();
  });
  it("returns the pattern when present", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [basePatternRow] });
    const out = await getPatternBySlug("aadsts20012-ws-fed");
    expect(out?.slug).toBe("aadsts20012-ws-fed");
  });
});

describe("upsertSeedPattern", () => {
  it("upserts every starter pattern without throwing", async () => {
    for (const seed of SEED_PATTERNS) {
      mockWriteQuery.mockResolvedValueOnce({
        rows: [{ ...basePatternRow, slug: seed.slug, name: seed.name, category: seed.category }],
      });
      const out = await upsertSeedPattern(seed);
      expect(out.slug).toBe(seed.slug);
    }
    expect(mockWriteQuery).toHaveBeenCalledTimes(SEED_PATTERNS.length);
    const [sql] = mockWriteQuery.mock.calls[0];
    expect(sql).toMatch(/ON CONFLICT \(slug\) DO UPDATE/);
  });
});
