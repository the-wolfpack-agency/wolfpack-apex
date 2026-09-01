/**
 * What business objects does this system manage? Inferred from what is on
 * screen, because the schema is not ours to read.
 *
 * WHY IT IS NOT DONE FROM TABLES, WHICH WAS THE OBVIOUS PLAN. A table on a
 * screen looks like a business object showing itself: columns are attributes,
 * rows are records. Mapping a real tenant, table detection found nine tables,
 * every one of them named "untitled", with columns "1", "2", "3", "4".
 *
 * They were layout. The application uses tables to position things, which was
 * ordinary practice for years and is still everywhere, and no amount of
 * reading columns turns a layout grid into an entity. A mapper that trusted
 * them would have reported nine business objects with four numbered fields
 * each, which is worse than reporting nothing: it is confident and wrong, and
 * a reader has no way to tell from the output.
 *
 * WHAT ACTUALLY CARRIES THE SIGNAL, in order of how much it can be trusted:
 *
 *   1. THE URL. A path segment that varies across sibling screens is the
 *      system naming its own objects. /org/porschecrm/build and
 *      /org/pcnausers/build differ in exactly the place the object lives.
 *      This is the strongest evidence available and it costs nothing, because
 *      the shape sampler already computed it while deciding what to skip.
 *
 *   2. FORMS. A form's fields are attributes with names somebody chose for a
 *      human to read. Furniture is excluded first: a search box in the header
 *      is not an entity, and form-inventory already knows the difference.
 *
 *   3. TABLES, but only where the columns are plausibly names rather than
 *      positions. This is the weakest source and is treated as such.
 *
 * EVERY ATTRIBUTE CARRIES ITS SOURCE, so a reviewer can check rather than
 * trust. An inferred map that cannot be audited is a guess with formatting.
 */

import type { InferredEntity, MappedForm } from "./types";
import type { ShapeReading } from "./shapes";
import { inventoryForms } from "./form-inventory";

/**
 * Path segments that name a screen rather than a thing.
 *
 * Taken from what real systems actually use. Without this, "build" and
 * "settings" are reported as business objects because they sit in the same
 * position as one.
 */
const SCREEN_WORDS = new Set([
  "build", "publish", "entries", "all-entries", "edit", "new", "create", "view",
  "list", "index", "home", "settings", "admin", "detail", "details", "summary",
  "report", "reports", "export", "import", "search", "preview", "share", "help",
  "login", "logout", "account", "profile", "dashboard", "overview", "api", "docs",
]);

/**
 * A segment that identifies one record rather than a kind of record.
 *
 * LENGTH AND A DIGIT ARE NOT ENOUGH, which an end-to-end test caught before
 * this ever ran again. The first version called anything long with a digit in
 * it an id, and the real tenant has a form named
 * "thewolfpackagencyinvoiceandw9collectionform": twenty-two characters and a
 * 9, so a genuine business object silently disappeared from the map. The
 * comment above it claimed the pattern was deliberately narrow. It was not.
 *
 * What actually separates them is that names are made of WORDS and ids are
 * not. "invoiceandw9collection" has letter runs ten long and one digit in
 * twenty-two characters; "a1b2c3d4e5f6g7h8" has no letter run longer than one
 * and is half digits. Hex ids have long letter runs but a high digit share, so
 * both signals are needed and either one is enough.
 */
const ID_DIGIT_SHARE = 0.25;
const ID_MAX_LETTER_RUN = 4;

function looksLikeRecordId(s: string): boolean {
  if (s.length < 15) return false;
  const digits = (s.match(/\d/g) ?? []).length;
  if (digits === 0) return false;
  if (digits / s.length >= ID_DIGIT_SHARE) return true;
  const longestLetterRun = Math.max(0, ...(s.match(/[a-z]+/gi) ?? []).map((r) => r.length));
  return longestLetterRun <= ID_MAX_LETTER_RUN;
}

/** Screen words with punctuation removed, for comparing against display text. */
const SCREEN_WORDS_SQUASHED = new Set([...SCREEN_WORDS].map((w) => w.replace(/[^a-z0-9]/g, "")));

function isEntityName(segment: string): boolean {
  const s = segment.toLowerCase();
  if (!s || s.length < 3) return false;
  if (SCREEN_WORDS.has(s)) return false;
  /* PAGINATION IS NOT A BUSINESS OBJECT. The real tenant serves page two of a
     list at "/form/1-all-entries", and that segment sits in the same position
     an object name sits in, so the first live run reported "1-all-entries" as
     something the system manages. */
  if (SCREEN_WORDS.has(s.replace(/^\d+[-_]/, ""))) return false;
  if (looksLikeRecordId(s)) return false;
  /* Purely numeric, a version marker, a file extension. */
  if (/^\d+$/.test(s) || /^v\d/.test(s) || s.includes(".")) return false;
  return true;
}

/**
 * Is this column name a name, or a position?
 *
 * The question the Cognito run made necessary. "1" is not an attribute.
 */
export function isMeaningfulColumn(column: string): boolean {
  const c = column.trim();
  if (c.length < 2) return false;
  if (/^\d+$/.test(c)) return false;
  /* Placeholder headers that carry no meaning: "col1", "column 3", "field2". */
  if (/^(col|column|field|header)\s*\d*$/i.test(c)) return false;
  return /[a-z]/i.test(c);
}

/** Fields that every form has and no entity is described by. */
const NON_ATTRIBUTE_FIELD = /^(submit|reset|button|csrf|token|_|search|q|query)$/i;

function isAttribute(name: string): boolean {
  const n = name.trim();
  if (n.length < 2) return false;
  if (NON_ATTRIBUTE_FIELD.test(n)) return false;
  return /[a-z]/i.test(n);
}

export interface EntitySurface {
  signature: string;
  url: string;
  title: string | null;
  headings: string[];
  forms: MappedForm[];
  tables: { caption: string | null; columns: string[]; rowCount: number }[];
}

/** Segment index a shape varies at, or -1 when it varies nowhere. */
function starIndex(shape: string): number {
  return shape.split("/").filter(Boolean).indexOf("*");
}

function segmentsOf(url: string): string[] {
  try {
    return new URL(url).pathname.split("/").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Best human name for an object, given the screens that belong to it.
 *
 * Prefers a title or heading the system itself displays, because a person
 * wrote it for a person. Falls back to the slug, which is at least real. It
 * never invents spacing or capitalisation: "porschecrm" is left alone rather
 * than guessed into "Porsche CRM", since a wrong guess reads as authoritative
 * and there is no way for a reader to spot it.
 */
function displayName(slug: string, surfaces: EntitySurface[]): string {
  const squashed = slug.replace(/[^a-z0-9]/gi, "").toLowerCase();
  for (const s of surfaces) {
    for (const candidate of [s.title, ...s.headings]) {
      const text = (candidate ?? "").trim();
      if (!text || text.length > 60) continue;
      if (text.replace(/[^a-z0-9]/gi, "").toLowerCase().includes(squashed)) {
        return stripScreenSuffix(text);
      }
    }
  }
  return slug;
}

/**
 * "Change Management Plan - All Entries" is a screen. The object is "Change
 * Management Plan".
 *
 * Applications title a page after the thing AND the view of it, so taking the
 * title verbatim names every business object after whichever screen happened
 * to be opened first. The first live run produced exactly that: a client
 * system whose objects were all called "... - All Entries".
 *
 * Only strips a trailing segment that is a KNOWN screen word. A product
 * genuinely called "Acme - Field Service" keeps its name, because guessing
 * would be worse than the problem: an object silently renamed reads as
 * authoritative and there is no way for a reader to spot it.
 */
function stripScreenSuffix(title: string): string {
  const m = /^(.*\S)\s*[-|\u2013\u2014]\s*([^-|\u2013\u2014]+)$/.exec(title);
  if (!m) return title;
  const tail = m[2].replace(/[^a-z0-9]/gi, "").toLowerCase();
  return SCREEN_WORDS_SQUASHED.has(tail) ? m[1].trim() : title;
}

/**
 * Infer the business objects a system manages.
 *
 * Patterns come from the shape sampler and are optional: without them this
 * still works from URL structure directly, just with less confidence about
 * which segment is the varying one.
 */
export function inferEntities(
  surfaces: EntitySurface[],
  patterns: ShapeReading[] = [],
): InferredEntity[] {
  /* THE VARYING SEGMENT, TAKEN FROM THE SAMPLER'S WORK. A shape with several
     instances is the system saying "these are all the same kind of screen for
     different things", and the differing segment names the things. */
  const slugPositions = new Map<string, Set<number>>();
  for (const p of patterns) {
    if (p.instances.length < 2) continue;
    const idx = starIndex(p.shape);
    if (idx < 0) continue;
    for (const instance of p.instances) {
      const segment = instance.split("/").filter(Boolean)[idx];
      if (!segment || !isEntityName(segment)) continue;
      const at = slugPositions.get(segment) ?? new Set<number>();
      at.add(idx);
      slugPositions.set(segment, at);
    }
  }

  /* Without patterns, fall back to every segment that repeats across surfaces
     in the same position, which is the same idea computed the long way. */
  if (slugPositions.size === 0) {
    const counts = new Map<string, Map<number, number>>();
    for (const s of surfaces) {
      segmentsOf(s.url).forEach((seg, i) => {
        if (!isEntityName(seg)) return;
        const at = counts.get(seg) ?? new Map<number, number>();
        at.set(i, (at.get(i) ?? 0) + 1);
        counts.set(seg, at);
      });
    }
    for (const [seg, at] of counts) slugPositions.set(seg, new Set(at.keys()));
  }

  /* Furniture excluded before anything is attributed: a header search box
     appearing on every screen would otherwise donate its field to every
     entity in the system. */
  const inventory = inventoryForms(
    surfaces.map((s) => ({ signature: s.signature, forms: s.forms })),
  );
  const contentForms = new Set(inventory.content.map((c) => c.form));

  /* THE TENANT CONTAINER IS NOT A BUSINESS OBJECT.
   *
   * The walk confines itself to the entry URL's first path segment, so that
   * segment is the same on every surface BY CONSTRUCTION. It sits in exactly
   * the position an object name sits in and is not one: on the real tenant it
   * would have been reported as an entity called "porscheacademyus", the
   * company itself, alongside the forms it contains.
   *
   * Only the first position, and only when it never varies. A deeper segment
   * that happens to be constant may well be a system with one object in it,
   * and dropping that would lose the only thing there was to find. */
  const firstSegments = new Set(surfaces.map((s) => segmentsOf(s.url)[0]).filter(Boolean));
  const container = surfaces.length > 1 && firstSegments.size === 1 ? [...firstSegments][0] : null;

  const entities: InferredEntity[] = [];

  for (const [slug, positions] of slugPositions) {
    if (slug === container && positions.has(0) && positions.size === 1) continue;
    const own = surfaces.filter((s) => {
      const segs = segmentsOf(s.url);
      return [...positions].some((i) => segs[i] === slug);
    });
    if (own.length === 0) continue;

    const attributes = new Map<string, InferredEntity["evidence"][number]["kind"]>();
    const evidence: InferredEntity["evidence"] = [];

    for (const s of own) {
      let contributed: InferredEntity["evidence"][number]["kind"] | null = null;

      for (const form of s.forms) {
        if (!contentForms.has(form)) continue;
        for (const field of form.fields) {
          if (!isAttribute(field.name)) continue;
          if (!attributes.has(field.name)) attributes.set(field.name, "form");
          contributed = "form";
        }
      }

      for (const table of s.tables) {
        const columns = table.columns.filter(isMeaningfulColumn);
        /* A table whose columns are all positions is layout, and contributes
           nothing rather than contributing noise. */
        if (columns.length === 0) continue;
        for (const c of columns) if (!attributes.has(c)) attributes.set(c, "table");
        contributed ??= "table";
      }

      evidence.push({ surface: s.signature, kind: contributed ?? "nav" });
    }

    entities.push({
      name: displayName(slug, own),
      evidence,
      attributes: [...attributes.keys()].sort(),
    });
  }

  /* Most evidence first: an object seen on four screens is more certainly an
     object than one seen on one. */
  return entities.sort(
    (a, b) => b.evidence.length - a.evidence.length || a.name.localeCompare(b.name),
  );
}
