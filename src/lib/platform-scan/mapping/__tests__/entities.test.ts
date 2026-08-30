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

/**
 * Telling an opaque id from a long name, which the first version got wrong.
 *
 * It called anything fifteen characters or longer with a digit in it an id.
 * The real tenant has a form named "thewolfpackagencyinvoiceandw9collectionform",
 * so a genuine business object silently disappeared from the map. Names are
 * made of words; ids are not.
 */
describe("long names that are not ids", () => {
  const named = (slug: string) =>
    inferEntities([
      surface({ url: `https://x.test/org/${slug}/build` }),
      surface({ url: `https://x.test/org/other/build` }),
    ]).map((e) => e.name);

  it("keeps a real form name that happens to contain a digit", () => {
    expect(named("thewolfpackagencyinvoiceandw9collectionform")).toContain(
      "thewolfpackagencyinvoiceandw9collectionform",
    );
  });

  it("keeps long names with no digits at all", () => {
    expect(named("brandambassadorchangemanagementplan")).toContain(
      "brandambassadorchangemanagementplan",
    );
  });

  it("still rejects an alternating id", () => {
    expect(named("a1b2c3d4e5f6g7h8")).not.toContain("a1b2c3d4e5f6g7h8");
  });

  it("still rejects a digit-heavy id", () => {
    expect(named("0015g00000XyZaBAAV")).not.toContain("0015g00000XyZaBAAV");
  });

  it("still rejects a hex id, which has long letter runs but many digits", () => {
    expect(named("aabbccddeeff1122")).not.toContain("aabbccddeeff1122");
  });
});

/**
 * What the first live run against a real tenant got wrong.
 *
 * Every string here is copied from that output on 2026-08-30. It walked 39
 * screens of a real Cognito Forms account and reported 19 business objects,
 * of which one was a pagination segment and most were named after a screen.
 */
describe("the first live run's mistakes", () => {
  const withTitle = (slug: string, title: string) =>
    inferEntities([
      surface({ url: `https://x.test/porscheacademyus/${slug}/all-entries`, title }),
      surface({ url: `https://x.test/porscheacademyus/${slug}/build`, title }),
      surface({ url: `https://x.test/porscheacademyus/other/build`, title: "Other" }),
    ]).map((e) => e.name);

  /* Reported as "Change Management Plan - All Entries": the object named after
     whichever screen happened to be opened first. */
  it("names the object, not the screen it was seen on", () => {
    expect(withTitle("changemanagementplan", "Change Management Plan - All Entries")).toContain(
      "Change Management Plan",
    );
  });

  it("strips the suffix however the title punctuates it", () => {
    expect(withTitle("porschecrm", "Porsche CRM | Entries")).toContain("Porsche CRM");
    expect(withTitle("pcnausers", "PCNA Users – Build")).toContain("PCNA Users");
  });

  /* GUESSING WOULD BE WORSE THAN THE PROBLEM. A product genuinely called
     "Acme - Field Service" keeps its name; an object silently renamed reads as
     authoritative and no reader can spot it. */
  it("leaves a real name that merely contains a dash alone", () => {
    expect(withTitle("acmefieldservice", "Acme - Field Service")).toContain("Acme - Field Service");
  });

  /* Reported as a business object called "1-all-entries", which is page two of
     a list. */
  it("does not report pagination as something the system manages", () => {
    const names = inferEntities([
      surface({ url: "https://x.test/porscheacademyus/changemanagementplan/1-all-entries" }),
      surface({ url: "https://x.test/porscheacademyus/porschecrm/1-all-entries" }),
    ]).map((e) => e.name);
    expect(names).not.toContain("1-all-entries");
    expect(names).toEqual(expect.arrayContaining(["changemanagementplan", "porschecrm"]));
  });

  /* The two screens of one form are one object, not two. */
  it("counts a form once however many of its screens were opened", () => {
    const names = withTitle("changemanagementplan", "Change Management Plan - All Entries");
    expect(names.filter((n) => n.startsWith("Change Management Plan"))).toHaveLength(1);
  });
});
