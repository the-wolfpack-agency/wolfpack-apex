/**
 * brief-versions unit tests.
 *
 * Mocks:
 *   - @/lib/db (safeQuery, writeQuery, WriteQueryError) — strict-throw on
 *     writes so silent-discard surfaces as an error in tests too.
 *   - @/lib/analytics (trackEvent) — we assert we emit the right event
 *     with the right metadata on restore.
 *
 * The UNION query tested here is the single round-trip that powers
 * the Version History panel; the restore path is the only WRITE and
 * therefore the only place that can silently destroy user work. Both
 * deserve thorough coverage.
 */

const safeQueryMock = jest.fn();
const writeQueryMock = jest.fn();
const trackMock = jest.fn();

class MockWriteQueryError extends Error {
  readonly code: "no_database" | "db_error" | "unexpected_row_count";
  constructor(
    message: string,
    code: "no_database" | "db_error" | "unexpected_row_count",
  ) {
    super(message);
    this.name = "WriteQueryError";
    this.code = code;
  }
}

jest.mock("@/lib/db", () => ({
  safeQuery: (...args: unknown[]) => safeQueryMock(...args),
  writeQuery: (...args: unknown[]) => writeQueryMock(...args),
  WriteQueryError: MockWriteQueryError,
}));

jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: unknown[]) => trackMock(...args),
}));

import {
  listVersionsForSite,
  diffBriefs,
  restoreVersion,
  RestoreVersionError,
  type BriefVersionEntry,
} from "@/lib/brief-versions";
import type { SiteBrief } from "@/lib/sites-schema";

const BRIEF_A: SiteBrief = {
  client: "cftr",
  product: { name: "CFTR" },
  pages: [
    {
      route: "/",
      sections: [
        { type: "hero", heading: "Hello", body: "Alpha" },
        { type: "text", heading: "About", body: "Short" },
      ],
    },
  ],
  theme: { colors: { primary: "#111111" } },
};

const BRIEF_B: SiteBrief = {
  client: "cftr",
  product: { name: "CFTR" },
  pages: [
    {
      route: "/",
      sections: [
        { type: "hero", heading: "Hi there", body: "Alpha" },
        { type: "text", heading: "About", body: "Short" },
        { type: "callout", body: "New section" },
      ],
    },
  ],
  theme: { colors: { primary: "#ff0000", accent: "#00ff00" } },
};

beforeEach(() => {
  jest.clearAllMocks();
  safeQueryMock.mockResolvedValue({ rows: [], fromCache: false });
  writeQueryMock.mockResolvedValue({ rows: [{ id: "ok" }] });
});

/* ---------------------- listVersionsForSite --------------------------- */

describe("listVersionsForSite", () => {
  it("issues one UNION query against both source tables, ordered DESC", async () => {
    safeQueryMock.mockResolvedValueOnce({
      rows: [
        {
          id: "edit_e1",
          kind: "prompt_edit",
          site_id: "site_1",
          brief: BRIEF_B,
          author_id: "u_1",
          author_role: "sales",
          detail_mime: null,
          detail_size: null,
          detail_model: "claude-haiku",
          detail_instruction: "Change hero heading",
          created_at: "2026-04-19T10:00:00Z",
          parent_version_id: "hash_a",
        },
        {
          id: "gen_g1",
          kind: "ai_extraction",
          site_id: "site_1",
          brief: BRIEF_A,
          author_id: "u_1",
          author_role: null,
          detail_mime: "image/png",
          detail_size: 123456,
          detail_model: "claude-haiku",
          detail_instruction: null,
          created_at: "2026-04-19T08:00:00Z",
          parent_version_id: null,
        },
      ],
      fromCache: false,
    });

    const versions = await listVersionsForSite("site_1");
    expect(versions).toHaveLength(2);
    expect(versions[0].id).toBe("edit_e1");
    expect(versions[0].kind).toBe("prompt_edit");
    expect(versions[1].id).toBe("gen_g1");
    expect(versions[1].kind).toBe("ai_extraction");

    const [sql, params] = safeQueryMock.mock.calls[0];
    expect(String(sql)).toContain("UNION ALL");
    expect(String(sql)).toContain("apex_site_brief_generations");
    expect(String(sql)).toContain("apex_site_brief_edits");
    expect(String(sql)).toMatch(/ORDER BY created_at DESC/);
    expect(params[0]).toBe("site_1");
  });

  it("returns [] on empty site", async () => {
    safeQueryMock.mockResolvedValueOnce({ rows: [], fromCache: false });
    const versions = await listVersionsForSite("site_empty");
    expect(versions).toEqual([]);
  });

  it("generates a plain-English summary for ai_extraction rows", async () => {
    safeQueryMock.mockResolvedValueOnce({
      rows: [
        {
          id: "gen_g1",
          kind: "ai_extraction",
          site_id: "site_1",
          brief: BRIEF_A,
          author_id: "u_1",
          author_role: null,
          detail_mime: "image/png",
          detail_size: 5120,
          detail_model: "claude-haiku",
          detail_instruction: null,
          created_at: "2026-04-19T00:00:00Z",
          parent_version_id: null,
        },
      ],
      fromCache: false,
    });
    const [v] = await listVersionsForSite("site_1");
    expect(v.summary).toMatch(/AI extracted/);
    expect(v.summary).toMatch(/image\/png/);
    expect(v.summary).toMatch(/5\.0 KB/);
  });

  it("generates a summary containing the instruction for prompt_edit rows", async () => {
    safeQueryMock.mockResolvedValueOnce({
      rows: [
        {
          id: "edit_e1",
          kind: "prompt_edit",
          site_id: "site_1",
          brief: BRIEF_B,
          author_id: "u_1",
          author_role: "sales",
          detail_mime: null,
          detail_size: null,
          detail_model: "claude-haiku",
          detail_instruction: "Make the hero heading punchier",
          created_at: "2026-04-19T00:00:00Z",
          parent_version_id: null,
        },
      ],
      fromCache: false,
    });
    const [v] = await listVersionsForSite("site_1");
    expect(v.summary).toMatch(/Edited/);
    expect(v.summary).toMatch(/punchier/);
  });

  it("parses brief when the DB returns a JSON string (jsonb → string)", async () => {
    safeQueryMock.mockResolvedValueOnce({
      rows: [
        {
          id: "edit_e1",
          kind: "prompt_edit",
          site_id: "site_1",
          brief: JSON.stringify(BRIEF_A),
          author_id: "u_1",
          author_role: "sales",
          detail_mime: null,
          detail_size: null,
          detail_model: null,
          detail_instruction: "x",
          created_at: "2026-04-19T00:00:00Z",
          parent_version_id: null,
        },
      ],
      fromCache: false,
    });
    const [v] = await listVersionsForSite("site_1");
    expect(v.brief.product.name).toBe("CFTR");
  });

  it("clamps limits to sensible bounds (1..200)", async () => {
    safeQueryMock.mockResolvedValue({ rows: [], fromCache: false });
    await listVersionsForSite("site_1", { limit: 9999 });
    expect(safeQueryMock.mock.calls[0][1][1]).toBe(200);
    safeQueryMock.mockClear();
    await listVersionsForSite("site_1", { limit: 0 });
    expect(safeQueryMock.mock.calls[0][1][1]).toBe(1);
  });
});

/* --------------------------- diffBriefs ------------------------------- */

describe("diffBriefs", () => {
  it("returns [] for identical briefs", () => {
    expect(diffBriefs(BRIEF_A, BRIEF_A)).toEqual([]);
  });

  it("detects a replaced primitive leaf", () => {
    const a: SiteBrief = {
      client: "x",
      product: { name: "X" },
      pages: [{ route: "/", sections: [{ type: "hero", heading: "A" }] }],
    };
    const b: SiteBrief = {
      client: "x",
      product: { name: "X" },
      pages: [{ route: "/", sections: [{ type: "hero", heading: "B" }] }],
    };
    const d = diffBriefs(a, b);
    expect(d).toHaveLength(1);
    expect(d[0].op).toBe("replace");
    expect(d[0].path).toBe("/pages/0/sections/0/heading");
    expect(d[0].before).toBe("A");
    expect(d[0].after).toBe("B");
  });

  it("detects an added section", () => {
    const d = diffBriefs(BRIEF_A, BRIEF_B);
    const addEntry = d.find(
      (e) => e.op === "add" && e.path === "/pages/0/sections/2",
    );
    expect(addEntry).toBeTruthy();
  });

  it("detects a removed field via remove op", () => {
    const a: SiteBrief = {
      client: "x",
      product: { name: "X", tagline: "line" },
      pages: [{ route: "/", sections: [] }],
    };
    const b: SiteBrief = {
      client: "x",
      product: { name: "X" },
      pages: [{ route: "/", sections: [] }],
    };
    const d = diffBriefs(a, b);
    const rem = d.find(
      (e) => e.op === "remove" && e.path === "/product/tagline",
    );
    expect(rem).toBeTruthy();
  });

  it("recurses into theme.colors", () => {
    const d = diffBriefs(BRIEF_A, BRIEF_B);
    const paths = d.map((e) => e.path);
    expect(paths).toContain("/theme/colors/primary");
    // accent is new on B — should show up as add
    const accent = d.find((e) => e.path === "/theme/colors/accent");
    expect(accent?.op).toBe("add");
    expect(accent?.after).toBe("#00ff00");
  });

  it("handles completely missing top-level fields (e.g. theme absent)", () => {
    const a: SiteBrief = { client: "x", product: { name: "X" }, pages: [] };
    const b: SiteBrief = {
      client: "x",
      product: { name: "X" },
      pages: [],
      theme: { colors: { primary: "#fff" } },
    };
    const d = diffBriefs(a, b);
    expect(d.some((e) => e.path.startsWith("/theme"))).toBe(true);
  });

  it("escapes / and ~ in object keys per RFC 6902", () => {
    const a: SiteBrief = {
      client: "x",
      product: { name: "X" },
      pages: [],
      // deliberately exotic key to exercise pointer escaping
      theme: { "weird/key": "a" } as unknown as SiteBrief["theme"],
    };
    const b: SiteBrief = {
      client: "x",
      product: { name: "X" },
      pages: [],
      theme: { "weird/key": "b" } as unknown as SiteBrief["theme"],
    };
    const d = diffBriefs(a, b);
    expect(d[0].path).toContain("~1");
  });
});

/* --------------------------- restoreVersion --------------------------- */

describe("restoreVersion", () => {
  function stubList(target: BriefVersionEntry | null) {
    // listVersionsForSite is invoked internally; shape the rows.
    if (!target) {
      safeQueryMock.mockResolvedValueOnce({ rows: [], fromCache: false });
      return;
    }
    safeQueryMock.mockResolvedValueOnce({
      rows: [
        {
          id: target.id,
          kind: target.kind,
          site_id: target.siteId,
          brief: target.brief,
          author_id: target.authorId,
          author_role: target.authorRole,
          detail_mime: null,
          detail_size: null,
          detail_model: null,
          detail_instruction: "past edit",
          created_at: target.createdAt,
          parent_version_id: null,
        },
      ],
      fromCache: false,
    });
  }

  it("throws RestoreVersionError(version_not_found) when no matching row", async () => {
    stubList(null);
    await expect(
      restoreVersion({
        siteId: "site_1",
        toVersionId: "edit_nope",
        userId: "u_1",
        userRole: "sales",
      }),
    ).rejects.toBeInstanceOf(RestoreVersionError);
  });

  it("throws RestoreVersionError(site_not_found) when project row missing", async () => {
    stubList({
      id: "edit_e1",
      kind: "prompt_edit",
      siteId: "site_1",
      brief: BRIEF_A,
      authorId: "u_1",
      authorRole: "sales",
      summary: "x",
      createdAt: "2026-04-19T00:00:00Z",
      parentVersionId: null,
    });
    // Current-brief SELECT returns []
    safeQueryMock.mockResolvedValueOnce({ rows: [], fromCache: false });

    await expect(
      restoreVersion({
        siteId: "site_1",
        toVersionId: "edit_e1",
        userId: "u_1",
        userRole: "sales",
      }),
    ).rejects.toMatchObject({ reason: "site_not_found" });
  });

  it("uses writeQuery with expectRows: 1 for the project update", async () => {
    stubList({
      id: "edit_e1",
      kind: "prompt_edit",
      siteId: "site_1",
      brief: BRIEF_A,
      authorId: "u_1",
      authorRole: "sales",
      summary: "x",
      createdAt: "2026-04-19T00:00:00Z",
      parentVersionId: null,
    });
    safeQueryMock.mockResolvedValueOnce({
      rows: [{ brief: BRIEF_B }],
      fromCache: false,
    });
    writeQueryMock.mockResolvedValue({ rows: [{ id: "ok" }] });

    await restoreVersion({
      siteId: "site_1",
      toVersionId: "edit_e1",
      userId: "u_1",
      userRole: "sales",
    });

    // First writeQuery = UPDATE apex_site_projects
    const [sql1, , opts1] = writeQueryMock.mock.calls[0];
    expect(String(sql1)).toContain("UPDATE apex_site_projects");
    expect(opts1).toEqual({ expectRows: 1 });
  });

  it("inserts a kind=restore audit row marked rejection_reason='restore'", async () => {
    stubList({
      id: "edit_e1",
      kind: "prompt_edit",
      siteId: "site_1",
      brief: BRIEF_A,
      authorId: "u_1",
      authorRole: "sales",
      summary: "x",
      createdAt: "2026-04-19T00:00:00Z",
      parentVersionId: null,
    });
    safeQueryMock.mockResolvedValueOnce({
      rows: [{ brief: BRIEF_B }],
      fromCache: false,
    });
    writeQueryMock.mockResolvedValue({ rows: [{ id: "ok" }] });

    await restoreVersion({
      siteId: "site_1",
      toVersionId: "edit_e1",
      userId: "u_1",
      userRole: "sales",
    });

    expect(writeQueryMock).toHaveBeenCalledTimes(2);
    const [sql2, params2, opts2] = writeQueryMock.mock.calls[1];
    expect(String(sql2)).toContain("INSERT INTO apex_site_brief_edits");
    expect(String(sql2)).toContain("'restore'");
    expect(opts2).toEqual({ expectRows: 1 });
    // user_id + user_role recorded
    expect(params2[2]).toBe("u_1");
    expect(params2[3]).toBe("sales");
  });

  it("fires site.version_restored with field_changes count", async () => {
    stubList({
      id: "edit_e1",
      kind: "prompt_edit",
      siteId: "site_1",
      brief: BRIEF_A, // restore TARGET
      authorId: "u_1",
      authorRole: "sales",
      summary: "x",
      createdAt: "2026-04-19T00:00:00Z",
      parentVersionId: null,
    });
    // current brief = BRIEF_B
    safeQueryMock.mockResolvedValueOnce({
      rows: [{ brief: BRIEF_B }],
      fromCache: false,
    });
    writeQueryMock.mockResolvedValue({ rows: [{ id: "ok" }] });

    const expectedFieldChanges = diffBriefs(BRIEF_B, BRIEF_A).length;

    await restoreVersion({
      siteId: "site_1",
      toVersionId: "edit_e1",
      userId: "u_1",
      userRole: "sales",
    });

    expect(trackMock).toHaveBeenCalledWith(
      "site.version_restored",
      "u_1",
      "sales",
      expect.objectContaining({
        site_id: "site_1",
        from_version_id: "edit_e1",
        field_changes: expectedFieldChanges,
      }),
    );
  });

  it("returns a BriefVersionEntry with kind='restore' for the new row", async () => {
    stubList({
      id: "edit_e1",
      kind: "prompt_edit",
      siteId: "site_1",
      brief: BRIEF_A,
      authorId: "u_1",
      authorRole: "sales",
      summary: "x",
      createdAt: "2026-04-19T00:00:00Z",
      parentVersionId: null,
    });
    safeQueryMock.mockResolvedValueOnce({
      rows: [{ brief: BRIEF_B }],
      fromCache: false,
    });
    writeQueryMock.mockResolvedValue({ rows: [{ id: "ok" }] });

    const entry = await restoreVersion({
      siteId: "site_1",
      toVersionId: "edit_e1",
      userId: "u_1",
      userRole: "sales",
    });
    expect(entry.kind).toBe("restore");
    expect(entry.siteId).toBe("site_1");
    expect(entry.parentVersionId).toBe("edit_e1");
    expect(entry.brief).toEqual(BRIEF_A);
  });

  it("propagates WriteQueryError (no silent failure)", async () => {
    stubList({
      id: "edit_e1",
      kind: "prompt_edit",
      siteId: "site_1",
      brief: BRIEF_A,
      authorId: "u_1",
      authorRole: "sales",
      summary: "x",
      createdAt: "2026-04-19T00:00:00Z",
      parentVersionId: null,
    });
    safeQueryMock.mockResolvedValueOnce({
      rows: [{ brief: BRIEF_B }],
      fromCache: false,
    });
    writeQueryMock.mockRejectedValueOnce(
      new MockWriteQueryError("write failed", "unexpected_row_count"),
    );

    await expect(
      restoreVersion({
        siteId: "site_1",
        toVersionId: "edit_e1",
        userId: "u_1",
        userRole: "sales",
      }),
    ).rejects.toBeInstanceOf(MockWriteQueryError);
  });
});
