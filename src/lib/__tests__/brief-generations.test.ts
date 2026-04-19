/**
 * brief-generations CRUD tests.
 *
 * safeQuery is mocked (same pattern as brief-edit.test.ts) so we assert
 * the SQL + parameter shape. Matches the triple-write contract: the row
 * lands in Postgres as the canonical record; the learning loop reads
 * from the view alias.
 */

const mockSafeQuery = jest.fn();
jest.mock("@/lib/db", () => ({
  safeQuery: (...args: unknown[]) => mockSafeQuery(...args),
  query: jest.fn(),
}));

import {
  insertBriefGeneration,
  recordBriefGenerationDecision,
  listBriefGenerationsForUser,
  findRecentGenerationBySha,
} from "@/lib/brief-generations";
import type { SiteBrief } from "@/lib/sites-schema";

const BRIEF: SiteBrief = {
  client: "cftr",
  product: { name: "CFTR" },
  pages: [{ route: "/", sections: [{ type: "hero", heading: "Hi" }] }],
};

beforeEach(() => {
  jest.clearAllMocks();
  mockSafeQuery.mockResolvedValue({ rows: [], fromCache: false });
});

describe("insertBriefGeneration", () => {
  it("writes all fields in the right positional order", async () => {
    await insertBriefGeneration({
      id: "site_brief_gen_abc",
      requestedBy: "u_1",
      sourceMime: "image/png",
      sourceSize: 123456,
      sourceSha256: "deadbeef",
      extractedBrief: BRIEF,
      extractedColors: ["#123456", "#abcdef"],
      detectedFont: "Inter",
      model: "claude-haiku-4-5-20251001",
      latencyMs: 550,
      tokenCostCents: 7,
    });
    expect(mockSafeQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockSafeQuery.mock.calls[0];
    expect(sql).toContain("INSERT INTO apex_site_brief_generations");
    expect(sql).toContain("accepted");
    expect(params[0]).toBe("site_brief_gen_abc");
    expect(params[1]).toBe("u_1");
    expect(params[2]).toBe("image/png");
    expect(params[3]).toBe(123456);
    expect(params[4]).toBe("deadbeef");
    // params[5] is stringified brief
    expect(JSON.parse(params[5]).client).toBe("cftr");
    expect(params[6]).toEqual(["#123456", "#abcdef"]);
    expect(params[7]).toBe("Inter");
    expect(params[8]).toBe("claude-haiku-4-5-20251001");
    expect(params[9]).toBe(550);
    expect(params[10]).toBe(7);
  });

  it("normalises missing optional fields to NULL", async () => {
    await insertBriefGeneration({
      id: "site_brief_gen_xyz",
      requestedBy: "u_2",
      sourceMime: "application/pdf",
      sourceSize: 10,
      sourceSha256: "cafebabe",
      extractedBrief: BRIEF,
      model: "claude-haiku-4-5-20251001",
      latencyMs: 10,
    });
    const [, params] = mockSafeQuery.mock.calls[0];
    expect(params[6]).toBeNull(); // extracted_colors
    expect(params[7]).toBeNull(); // detected_font
    expect(params[10]).toBeNull(); // token_cost_cents
  });
});

describe("recordBriefGenerationDecision", () => {
  it("flips accepted=true and returns linked project_id", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [{ project_id: "site_1" }],
      fromCache: false,
    });
    const out = await recordBriefGenerationDecision(
      "site_brief_gen_abc",
      true,
      "site_1",
    );
    expect(out.projectId).toBe("site_1");
    const [sql, params] = mockSafeQuery.mock.calls[0];
    expect(sql).toContain("UPDATE apex_site_brief_generations");
    expect(sql).toContain("SET accepted");
    expect(params[0]).toBe("site_brief_gen_abc");
    expect(params[1]).toBe(true);
    expect(params[2]).toBe("site_1");
  });

  it("flips accepted=false without touching project_id when null", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [{ project_id: null }],
      fromCache: false,
    });
    const out = await recordBriefGenerationDecision(
      "site_brief_gen_xyz",
      false,
    );
    expect(out.projectId).toBeNull();
    const [, params] = mockSafeQuery.mock.calls[0];
    expect(params[1]).toBe(false);
    expect(params[2]).toBeNull();
  });

  it("returns null when the row doesn't exist (shadow mode)", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: true });
    const out = await recordBriefGenerationDecision("unknown", true);
    expect(out.projectId).toBeNull();
  });
});

describe("listBriefGenerationsForUser", () => {
  it("fetches newest-first with a limit", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [
        { id: "g1", requested_by: "u_1", source_mime: "image/png" },
        { id: "g2", requested_by: "u_1", source_mime: "image/jpeg" },
      ],
      fromCache: false,
    });
    const out = await listBriefGenerationsForUser("u_1", 5);
    expect(out).toHaveLength(2);
    const [sql, params] = mockSafeQuery.mock.calls[0];
    expect(sql).toContain("ORDER BY created_at DESC");
    expect(sql).toContain("LIMIT");
    expect(params[0]).toBe("u_1");
    expect(params[1]).toBe(5);
  });
});

describe("findRecentGenerationBySha", () => {
  it("returns the most recent matching row", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [{ id: "g1", source_sha256: "sha_a" }],
      fromCache: false,
    });
    const out = await findRecentGenerationBySha("sha_a");
    expect(out?.id).toBe("g1");
    const [sql] = mockSafeQuery.mock.calls[0];
    expect(sql).toContain("source_sha256");
    expect(sql).toContain("LIMIT 1");
  });

  it("returns null when no row matches", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: false });
    const out = await findRecentGenerationBySha("sha_nope");
    expect(out).toBeNull();
  });
});
