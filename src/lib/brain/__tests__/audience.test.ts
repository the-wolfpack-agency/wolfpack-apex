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
    expect(mockQuery.mock.calls[0][1]).toEqual([["a", "b", "c"], "sales"]);
  });

  it("does not spend a query when the role reads everything", async () => {
    const out = await readableDocumentIds(["a", "b"], "cto");
    expect(out).toEqual(new Set(["a", "b"]));
    expect(mockQuery).not.toHaveBeenCalled();
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
    expect(mockQuery.mock.calls[0][1]).toEqual([["a"], "sales"]);
  });
});
