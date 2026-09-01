/**
 * Who may be quoted which document.
 *
 * Before this, retrieval had no permission model: any user holding
 * assistant.use could be quoted any document in the index, because both search
 * legs searched everything and neither was told who was asking.
 *
 * That is fine while the corpus is one company's own material. It stops being
 * fine the moment a client tenant holds HR files, dealer agreements and
 * manager-only process documents in the same index, which is exactly what the
 * SharePoint connector puts there.
 */
import { readsEverything, readableDocumentIds } from "../audience";

const mockQuery = jest.fn();
jest.mock("@/lib/db", () => ({ query: (...a: unknown[]) => mockQuery(...a) }));

beforeEach(() => {
  mockQuery.mockReset();
  process.env.DATABASE_URL = "postgres://test";
});

describe("who reads everything", () => {
  it.each(["cto", "CTO", "ceo", "admin"])("%s does", (role) => {
    expect(readsEverything(role)).toBe(true);
  });

  /* The list is short on purpose: it is the one somebody will be asked to
     justify. A dealer, a manager and a trainer are all ordinary readers. */
  it.each(["hr", "sales", "ops", "dev", "designer", "dealer", "manager", ""])(
    "%p does not",
    (role) => {
      expect(readsEverything(role)).toBe(false);
    },
  );
});

describe("narrowing a set of documents to what a role may read", () => {
  it("asks Postgres, and keeps only what it names", async () => {
    mockQuery.mockResolvedValue({ rows: [{ id: "a" }, { id: "c" }] });
    const out = await readableDocumentIds(["a", "b", "c"], "sales");
    expect(out).toEqual(new Set(["a", "c"]));
    const sql = String(mockQuery.mock.calls[0][0]);
    /* A document with no audience is workspace-wide, which is what a hand
       upload honestly is. Dropping those would invent a restriction nobody
       applied. */
    expect(sql).toMatch(/audience_roles IS NULL/);
    /* Params now carry the reads-everything flag and the non-corpus uploader
       list alongside the ids and the role. */
    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(params[0]).toEqual(["a", "b", "c"]);
    expect(params[1]).toBe(false);
    expect(params[2]).toBe("sales");
  });

  /* BEHAVIOR DELIBERATELY CHANGED on 2026-08-27, and the old assertion is
     replaced rather than relaxed.
     
     This used to short-circuit: a role that reads everything got its ids back
     without a query, which saved a round trip and was correct while the only
     question being asked was "may this role read it".
     
     It is no longer the only question. 744 of the 795 answerable documents in
     the Brain were written by the demo seeder or the platform scanner, and
     quoting one of those at somebody asking about their business is wrong
     regardless of their role. A CTO may read every document in the library;
     that is not a reason to answer them with a fixture.
     
     So the query always runs, the role predicate is skipped for a role that
     reads everything, and the corpus boundary applies to everybody. */
  it("still queries for a role that reads everything, to apply the corpus boundary", async () => {
    mockQuery.mockResolvedValue({ rows: [{ id: "a" }] });
    const out = await readableDocumentIds(["a", "b"], "cto");
    expect(mockQuery).toHaveBeenCalled();
    const params = mockQuery.mock.calls[0][1] as unknown[];
    /* The reads-everything flag is set, so the role predicate is a no-op... */
    expect(params[1]).toBe(true);
    /* ...but the uploader exclusion is still bound and still applied. */
    expect(String(mockQuery.mock.calls[0][0])).toMatch(/uploaded_by/);
    /* And "b" was excluded by the corpus boundary, not by the audience. */
    expect(out).toEqual(new Set(["a"]));
  });

  /* THE RULE THAT MATTERS. A retrieval that fails is a bad answer. A
     retrieval that leaks is an incident, so the failure mode is nothing
     rather than everything. */
  it("returns nothing when the lookup fails", async () => {
    mockQuery.mockRejectedValue(new Error("db down"));
    expect(await readableDocumentIds(["a", "b"], "sales")).toEqual(new Set());
  });

  it("returns nothing for an empty request without asking", async () => {
    expect(await readableDocumentIds([], "sales")).toEqual(new Set());
    expect(mockQuery).not.toHaveBeenCalled();
  });

  /* Case is a property of how somebody logged in, not of what they may read. */
  it("matches the role in lower case", async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await readableDocumentIds(["a"], "SALES");
    expect((mockQuery.mock.calls[0][1] as unknown[])[2]).toBe("sales");
  });
});
