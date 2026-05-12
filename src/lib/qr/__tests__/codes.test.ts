 
const mockSafeQuery = jest.fn();
const mockWriteQuery = jest.fn();
jest.mock("@/lib/db", () => ({
  safeQuery: (...a: any[]) => mockSafeQuery(...a),
  writeQuery: (...a: any[]) => mockWriteQuery(...a),
  query: jest.fn(),
}));

import {
  appendUtm,
  validateTargetUrl,
  generateSlug,
  createCode,
  listCodes,
  getCodeBySlug,
  getCodeById,
  updateCode,
  archiveCode,
} from "@/lib/qr/codes";

const ORIGINAL_DB_URL = process.env.DATABASE_URL;
beforeEach(() => {
  mockSafeQuery.mockReset();
  mockWriteQuery.mockReset();
  process.env.DATABASE_URL = "postgres://test";
});
afterAll(() => {
  if (ORIGINAL_DB_URL === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = ORIGINAL_DB_URL;
});

const dbRow = {
  id: "code-1",
  slug: "abc1234",
  target_url: "https://x.test/page",
  label: "Demo",
  utm_campaign: "spring",
  expires_at: null,
  archived_at: null,
  created_at: "2026-04-30T00:00:00.000Z",
  created_by_user_id: "u1",
  created_by_user_role: "ceo",
};

describe("generateSlug", () => {
  test("produces 7-char slugs from the safe alphabet", () => {
    for (let i = 0; i < 200; i += 1) {
      const slug = generateSlug();
      expect(slug).toHaveLength(7);
      /* No 0/o/1/i/l. */
      expect(slug).toMatch(/^[2-9a-hjkmnp-z]{7}$/);
    }
  });
  test("collisions are statistically rare across 1000 draws", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i += 1) seen.add(generateSlug());
    expect(seen.size).toBeGreaterThan(990);
  });
});

describe("validateTargetUrl", () => {
  test("accepts http and https", () => {
    expect(validateTargetUrl("https://x.test").protocol).toBe("https:");
    expect(validateTargetUrl("http://x.test").protocol).toBe("http:");
  });
  test("rejects ftp/javascript/data", () => {
    expect(() => validateTargetUrl("ftp://x.test")).toThrow(/http or https/);
    expect(() => validateTargetUrl("javascript:alert(1)")).toThrow(/http or https/);
  });
  test("rejects garbage", () => {
    expect(() => validateTargetUrl("not a url")).toThrow(/valid URL/);
    expect(() => validateTargetUrl("")).toThrow(/required/);
  });
  test("accepts URLs with paths and queries", () => {
    expect(validateTargetUrl("https://x.test/a/b?c=1#h").pathname).toBe("/a/b");
  });
});

describe("appendUtm", () => {
  test("no existing query string adds all three utm params", () => {
    const out = appendUtm("https://x.test/page", "spring");
    expect(out).toContain("utm_source=qr");
    expect(out).toContain("utm_medium=offline");
    expect(out).toContain("utm_campaign=spring");
  });
  test("preserves existing query string", () => {
    const out = appendUtm("https://x.test/page?ref=ad", "spring");
    expect(out).toContain("ref=ad");
    expect(out).toContain("utm_campaign=spring");
  });
  test("preserves hash fragment", () => {
    const out = appendUtm("https://x.test/page#section", "spring");
    expect(out).toContain("#section");
    expect(out).toContain("utm_campaign=spring");
  });
  test("overrides only utm_campaign, preserves existing utm_source/utm_medium", () => {
    const out = appendUtm(
      "https://x.test/page?utm_source=email&utm_medium=newsletter&utm_campaign=old",
      "fresh",
    );
    expect(out).toContain("utm_source=email");
    expect(out).toContain("utm_medium=newsletter");
    expect(out).toContain("utm_campaign=fresh");
    expect(out).not.toContain("utm_campaign=old");
  });
  test("null/empty campaign is a no-op", () => {
    expect(appendUtm("https://x.test/page", null)).toBe("https://x.test/page");
    expect(appendUtm("https://x.test/page", undefined)).toBe("https://x.test/page");
    expect(appendUtm("https://x.test/page", "")).toBe("https://x.test/page");
  });
  test("invalid url returned verbatim (no throw)", () => {
    expect(appendUtm("not-a-url", "x")).toBe("not-a-url");
  });
});

describe("createCode", () => {
  test("inserts with generated slug + returns mapped row", async () => {
    mockWriteQuery.mockResolvedValueOnce({ rows: [dbRow] });
    const code = await createCode({
      targetUrl: "https://x.test/page",
      label: "Demo",
      utmCampaign: "spring",
      userId: "u1",
      userRole: "ceo",
    });
    expect(code.slug).toBe("abc1234");
    expect(code.targetUrl).toBe("https://x.test/page");
    expect(code.utmCampaign).toBe("spring");
    expect(code.createdByUserId).toBe("u1");
  });

  test("retries on slug collision (unique violation)", async () => {
    const dupErr = new Error("duplicate key value violates unique constraint");
    mockWriteQuery
      .mockRejectedValueOnce(dupErr)
      .mockRejectedValueOnce(dupErr)
      .mockResolvedValueOnce({ rows: [dbRow] });
    const code = await createCode({
      targetUrl: "https://x.test/page",
      userId: "u1",
      userRole: "ceo",
    });
    expect(code.slug).toBe("abc1234");
    expect(mockWriteQuery).toHaveBeenCalledTimes(3);
  });

  test("gives up after 5 collisions", async () => {
    const dupErr = new Error("duplicate key value violates unique constraint");
    mockWriteQuery.mockRejectedValue(dupErr);
    await expect(
      createCode({
        targetUrl: "https://x.test/page",
        userId: "u1",
        userRole: "ceo",
      }),
    ).rejects.toThrow(/Failed to generate unique slug/);
  });

  test("rejects bad URL before hitting the DB", async () => {
    await expect(
      createCode({
        targetUrl: "ftp://x.test",
        userId: "u1",
        userRole: "ceo",
      }),
    ).rejects.toThrow(/http or https/);
    expect(mockWriteQuery).not.toHaveBeenCalled();
  });

  test("non-collision DB error bubbles up", async () => {
    mockWriteQuery.mockRejectedValue(new Error("connection refused"));
    await expect(
      createCode({
        targetUrl: "https://x.test/page",
        userId: "u1",
        userRole: "ceo",
      }),
    ).rejects.toThrow(/connection refused/);
  });
});

describe("listCodes", () => {
  test("default excludes archived, orders by created_at DESC, limit 100", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [dbRow] });
    const codes = await listCodes();
    expect(codes).toHaveLength(1);
    const [sql, params] = mockSafeQuery.mock.calls[0];
    expect(sql).toMatch(/archived_at IS NULL/);
    expect(sql).toMatch(/ORDER BY created_at DESC/);
    expect(params[params.length - 1]).toBe(100);
  });
  test("includeArchived=true skips the archived filter", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [] });
    await listCodes({ includeArchived: true });
    const [sql] = mockSafeQuery.mock.calls[0];
    expect(sql).not.toMatch(/archived_at IS NULL/);
  });
  test("userId filter scopes to created_by_user_id", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [] });
    await listCodes({ userId: "u9" });
    const [sql, params] = mockSafeQuery.mock.calls[0];
    expect(sql).toMatch(/created_by_user_id/);
    expect(params).toContain("u9");
  });
});

describe("getCodeBySlug / getCodeById", () => {
  test("getCodeBySlug returns mapped row or null", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [dbRow] });
    const code = await getCodeBySlug("abc1234");
    expect(code?.id).toBe("code-1");

    mockSafeQuery.mockResolvedValueOnce({ rows: [] });
    expect(await getCodeBySlug("missing")).toBeNull();
  });
  test("empty inputs short-circuit to null", async () => {
    expect(await getCodeBySlug("")).toBeNull();
    expect(await getCodeById("")).toBeNull();
    expect(mockSafeQuery).not.toHaveBeenCalled();
  });
});

describe("updateCode", () => {
  test("rejects empty patch", async () => {
    await expect(updateCode("code-1", {})).rejects.toThrow(/empty/);
  });
  test("builds dynamic SET list for provided fields only", async () => {
    mockWriteQuery.mockResolvedValueOnce({ rows: [{ ...dbRow, label: "New" }] });
    const code = await updateCode("code-1", { label: "New" });
    expect(code.label).toBe("New");
    const [sql] = mockWriteQuery.mock.calls[0];
    expect(sql).toMatch(/label = \$1/);
    expect(sql).toMatch(/updated_at = NOW\(\)/);
  });
  test("validates targetUrl when provided", async () => {
    await expect(
      updateCode("code-1", { targetUrl: "javascript:alert(1)" }),
    ).rejects.toThrow(/http or https/);
  });
});

describe("archiveCode", () => {
  test("sets archived_at = NOW(), returns row", async () => {
    mockWriteQuery.mockResolvedValueOnce({
      rows: [{ ...dbRow, archived_at: "2026-04-30T01:00:00Z" }],
    });
    const code = await archiveCode("code-1");
    expect(code.archivedAt).toBe("2026-04-30T01:00:00Z");
    const [sql] = mockWriteQuery.mock.calls[0];
    expect(sql).toMatch(/archived_at = NOW\(\)/);
  });
});
