/**
 * Entity inference, against the system that made it necessary.
 *
 * The form names and the layout-table shape are from a real tenant mapped on
 * 2026-08-29: nine tables, every one "untitled" with columns "1", "2", "3",
 * "4", because the application lays screens out with tables.
 */
import { inferEntities, isMeaningfulColumn, type EntitySurface } from "../entities";
import type { ShapeReading } from "../shapes";
import type { MappedForm } from "../types";

const form = (name: string, fields: string[]): MappedForm => ({
  name,
  method: "post",
  fields: fields.map((f) => ({ name: f, type: "text", required: false })),
  mutating: true,
});

const surface = (over: Partial<EntitySurface> & { url: string }): EntitySurface => ({
  signature: over.url,
  title: null,
  headings: [],
  forms: [],
  tables: [],
  ...over,
});

/* Layout, not data. The trap this whole file exists to avoid. */
const LAYOUT_TABLE = { caption: null, columns: ["1", "2", "3", "4"], rowCount: 6 };

const FORMS = ["porschecrm", "pcnausers", "changemanagementplan", "porschecentersusa"];

function cognitoLike(): { surfaces: EntitySurface[]; patterns: ShapeReading[] } {
  const surfaces = FORMS.flatMap((f) => [
    surface({
      url: `https://x.test/org/${f}/all-entries`,
      tables: [LAYOUT_TABLE],
      forms: [form("search", ["q"])],
    }),
    surface({
      url: `https://x.test/org/${f}/build`,
      forms: [form("search", ["q"]), form(f, ["fullName", "emailAddress", "centerNumber"])],
    }),
  ]);
  const patterns: ShapeReading[] = [
    {
      shape: "/org/*/all-entries",
      instances: FORMS.map((f) => `/org/${f}/all-entries`),
      visited: 2,
    },
    { shape: "/org/*/build", instances: FORMS.map((f) => `/org/${f}/build`), visited: 2 },
  ];
  return { surfaces, patterns };
}

describe("isMeaningfulColumn", () => {
  it("rejects the numbered columns a layout table produces", () => {
    for (const c of ["1", "2", "3", "4"]) expect(isMeaningfulColumn(c)).toBe(false);
  });

  it("rejects placeholder headers", () => {
    for (const c of ["col1", "Column 3", "field2"]) expect(isMeaningfulColumn(c)).toBe(false);
  });

  it("accepts a real column name", () => {
    for (const c of ["Full Name", "Email", "Center Number"]) {
      expect(isMeaningfulColumn(c)).toBe(true);
    }
  });
});

describe("inferring what a system manages", () => {
  it("names the objects from the varying path segment", () => {
    const { surfaces, patterns } = cognitoLike();
    const names = inferEntities(surfaces, patterns).map((e) => e.name);
    for (const f of FORMS) expect(names).toContain(f);
  });

  /* THE FAILURE THIS FILE IS NAMED AFTER. Nine tables of numbered columns
     would otherwise be reported as nine business objects with four fields
     each: confident, wrong, and unfalsifiable by a reader. */
  it("takes nothing from a table used for layout", () => {
    const { surfaces, patterns } = cognitoLike();
    const attrs = inferEntities(surfaces, patterns).flatMap((e) => e.attributes);
    for (const c of ["1", "2", "3", "4"]) expect(attrs).not.toContain(c);
  });

  it("takes attributes from form fields, which are names somebody chose", () => {
    const { surfaces, patterns } = cognitoLike();
    const crm = inferEntities(surfaces, patterns).find((e) => e.name === "porschecrm")!;
    expect(crm.attributes).toEqual(["centerNumber", "emailAddress", "fullName"]);
  });

  /* A search box on every screen is furniture. Without this it donates its
     field to every entity in the system, and every object in the report has a
     mysterious "q" attribute. */
  it("ignores a form that is part of the frame", () => {
    const { surfaces, patterns } = cognitoLike();
    const attrs = inferEntities(surfaces, patterns).flatMap((e) => e.attributes);
    expect(attrs).not.toContain("q");
  });

  it("does not mistake a screen name for a business object", () => {
    const { surfaces, patterns } = cognitoLike();
    const names = inferEntities(surfaces, patterns).map((e) => e.name);
    for (const w of ["build", "all-entries", "org"]) expect(names).not.toContain(w);
  });

  it("does not mistake a record id for a kind of record", () => {
    const surfaces = [
      surface({ url: "https://x.test/org/a1b2c3d4e5f6g7h8/view" }),
      surface({ url: "https://x.test/org/z9y8x7w6v5u4t3s2/view" }),
    ];
    expect(inferEntities(surfaces).map((e) => e.name)).toEqual([]);
  });

  it("cites the surfaces each conclusion came from", () => {
    const { surfaces, patterns } = cognitoLike();
    const crm = inferEntities(surfaces, patterns).find((e) => e.name === "porschecrm")!;
    expect(crm.evidence.map((e) => e.surface)).toEqual([
      "https://x.test/org/porschecrm/all-entries",
      "https://x.test/org/porschecrm/build",
    ]);
    expect(crm.evidence.some((e) => e.kind === "form")).toBe(true);
  });

  /* The system's own words beat the slug, because a person wrote them. */
  it("prefers a displayed title over the slug", () => {
    const surfaces = [
      surface({ url: "https://x.test/org/porschecrm/build", title: "Porsche CRM" }),
      surface({ url: "https://x.test/org/pcnausers/build", title: "PCNA Users" }),
    ];
    expect(inferEntities(surfaces).map((e) => e.name)).toContain("Porsche CRM");
  });

  /* It would be easy to turn "porschecrm" into "Porsche CRM" and be right
     most of the time. Being wrong the rest of the time is unreadable as an
     error, so the slug stands. */
  it("never invents a prettier name than it was given", () => {
    const surfaces = [
      surface({ url: "https://x.test/org/thewolfpackagencyinvoice/build" }),
      surface({ url: "https://x.test/org/porschecrm/build" }),
    ];
    expect(inferEntities(surfaces).map((e) => e.name)).toContain("thewolfpackagencyinvoice");
  });

  it("works without patterns, from url repetition alone", () => {
    const { surfaces } = cognitoLike();
    const names = inferEntities(surfaces).map((e) => e.name);
    for (const f of FORMS) expect(names).toContain(f);
  });

  it("finds nothing in an empty system rather than inventing something", () => {
    expect(inferEntities([])).toEqual([]);
  });
});

/**
 * The company is not one of its own business objects.
 *
 * The walk confines itself to the entry URL's first path segment, so that
 * segment is constant on every surface by construction and sits in exactly the
 * position an object name sits in. On the real tenant it would have been
 * reported as an entity named after the company.
 */
describe("the tenant container", () => {
  it("is not reported as a business object", () => {
    const surfaces = [
      surface({ url: "https://x.test/porscheacademyus/porschecrm/build" }),
      surface({ url: "https://x.test/porscheacademyus/pcnausers/build" }),
    ];
    const names = inferEntities(surfaces).map((e) => e.name);
    expect(names).not.toContain("porscheacademyus");
    expect(names).toEqual(expect.arrayContaining(["porschecrm", "pcnausers"]));
  });

  /* A deeper segment that never varies may be a system with one object in it,
     and dropping that would lose the only thing there was to find. */
  it("does not swallow a single-object system", () => {
    const surfaces = [
      surface({ url: "https://x.test/app/invoices/list" }),
      surface({ url: "https://x.test/app/invoices/new" }),
    ];
    expect(inferEntities(surfaces).map((e) => e.name)).toContain("invoices");
  });
});
