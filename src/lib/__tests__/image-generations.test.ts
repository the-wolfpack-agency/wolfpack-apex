/**
 * image-generations CRUD — INSERT + UPDATE + COUNT round-trip.
 *
 * Mocks safeQuery and asserts the exact SQL + param shape each helper
 * emits. Matches the brief-generations testing pattern so the learning
 * loop infra has a single mental model for "this row actually landed".
 */

const mockSafeQuery = jest.fn();
jest.mock("@/lib/db", () => ({
  safeQuery: (...args: unknown[]) => mockSafeQuery(...args),
}));

import {
  insertImageGeneration,
  markImageGenerationAccepted,
  countUserGenerationsSince,
  listImageGenerationsForUser,
} from "@/lib/image-generations";

beforeEach(() => {
  jest.clearAllMocks();
});

describe("insertImageGeneration", () => {
  it("inserts a row with all expected columns and NULL accepted", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: false });

    await insertImageGeneration({
      id: "img_gen_1",
      projectId: "site_1",
      requestedBy: "u_1",
      prompt: "A sunlit office",
      aspectRatio: "16:9",
      seed: 42,
      model: "fal-ai/flux/schnell",
      imageUrl: "https://raw.githubusercontent.com/acme/site/main/public/generated/img_gen_1.jpg",
      repoCommitted: true,
      costCents: 1,
      latencyMs: 4200,
    });

    expect(mockSafeQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockSafeQuery.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO apex_site_image_generations/);
    expect(sql).toMatch(/accepted/);
    // 11 positional params + implicit NULL for accepted via VALUES
    expect(params).toEqual([
      "img_gen_1",
      "site_1",
      "u_1",
      "A sunlit office",
      "16:9",
      42,
      "fal-ai/flux/schnell",
      "https://raw.githubusercontent.com/acme/site/main/public/generated/img_gen_1.jpg",
      true,
      1,
      4200,
    ]);
  });

  it("defaults optional fields to null/false when omitted", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: false });

    await insertImageGeneration({
      id: "img_gen_2",
      projectId: null,
      requestedBy: "u_1",
      prompt: "x",
      aspectRatio: "1:1",
      model: "fal-ai/flux/schnell",
      imageUrl: "",
      latencyMs: 100,
    });

    const params = mockSafeQuery.mock.calls[0][1];
    expect(params[1]).toBeNull(); // project_id
    expect(params[5]).toBeNull(); // seed
    expect(params[8]).toBe(false); // repo_committed default
    expect(params[9]).toBeNull(); // cost_cents
  });
});

describe("markImageGenerationAccepted", () => {
  it("flips accepted=true and returns project_id", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [{ project_id: "site_1" }],
      fromCache: false,
    });

    const out = await markImageGenerationAccepted("img_gen_1", true);
    expect(out.projectId).toBe("site_1");

    const [sql, params] = mockSafeQuery.mock.calls[0];
    expect(sql).toMatch(/UPDATE apex_site_image_generations/);
    expect(sql).toMatch(/SET accepted = \$2/);
    expect(params).toEqual(["img_gen_1", true]);
  });

  it("flips accepted=false for dismissals", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: false });
    const out = await markImageGenerationAccepted("img_gen_1", false);
    expect(out.projectId).toBeNull();
    expect(mockSafeQuery.mock.calls[0][1]).toEqual(["img_gen_1", false]);
  });
});

describe("countUserGenerationsSince", () => {
  it("returns the count from the first row", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [{ n: 7 }],
      fromCache: false,
    });

    const n = await countUserGenerationsSince("u_1", 24);
    expect(n).toBe(7);
    const [sql, params] = mockSafeQuery.mock.calls[0];
    expect(sql).toMatch(/COUNT\(\*\)/);
    expect(sql).toMatch(/requested_by = \$1/);
    expect(sql).toMatch(/NOW\(\) - INTERVAL '1 hour' \* \$2/);
    expect(params).toEqual(["u_1", 24]);
  });

  it("returns 0 when no row is returned (shadow mode)", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: true });
    expect(await countUserGenerationsSince("u_1")).toBe(0);
  });
});

describe("listImageGenerationsForUser", () => {
  it("returns rows sorted newest first with default limit=20", async () => {
    const fakeRows = [
      {
        id: "img_gen_2",
        project_id: "site_1",
        requested_by: "u_1",
        prompt: "recent",
        aspect_ratio: "16:9",
        seed: 1,
        model: "fal-ai/flux/schnell",
        image_url: "https://...",
        repo_committed: true,
        cost_cents: 1,
        latency_ms: 3000,
        accepted: true,
        created_at: "2026-04-18T12:00:00Z",
      },
    ];
    mockSafeQuery.mockResolvedValueOnce({ rows: fakeRows, fromCache: false });

    const out = await listImageGenerationsForUser("u_1");
    expect(out).toEqual(fakeRows);
    const [sql, params] = mockSafeQuery.mock.calls[0];
    expect(sql).toMatch(/ORDER BY created_at DESC/);
    expect(params).toEqual(["u_1", 20]);
  });
});
