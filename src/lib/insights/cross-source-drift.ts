/**
 * The same record, in two systems, with two different answers.
 *
 * #339 could say "contact lives in HubSpot and in the DMS". That is a
 * fact about the wiring and it is worth saying on day one, but the next
 * question is immediate and we had no answer for it: so which one is
 * right? The action chip shipped in that change reads "Compare contact
 * across both" and, until this file, nothing listened to it.
 *
 * This is the comparison. It is pure and takes two record sets, so the
 * matching and diffing rules can be argued with in a test rather than
 * against a live CRM.
 *
 * WHY MATCHING IS CONSERVATIVE
 *
 * A false match invents a disagreement between two different people and
 * destroys trust in every true one. So a match needs an identifier that
 * a human would also accept: an email address, or failing that a
 * normalized full name. Anything with neither is not guessed at, it is
 * counted as unmatchable and reported as such, because "we could not
 * line these up" is a real finding about their data and hiding it would
 * make the comparison look cleaner than it is.
 */

/** Fields that are supposed to differ between two systems. */
const IGNORED_FIELDS = new Set([
  "id",
  "created_at",
  "createdat",
  "updated_at",
  "updatedat",
  "lastmodifieddate",
  "createddate",
  "systemmodstamp",
  "etag",
  "url",
  "self",
  "_links",
]);

const EMAIL_KEYS = ["email", "emailaddress", "email_address", "primaryemail"];
const NAME_KEYS = ["name", "fullname", "full_name", "displayname"];
const FIRST_KEYS = ["firstname", "first_name", "givenname"];
const LAST_KEYS = ["lastname", "last_name", "surname", "familyname"];

/**
 * Keys that hold the record rather than being part of it.
 *
 * HubSpot returns { id, properties: { email, firstname, ... } }. Every
 * field a person would recognize is one level down, so a comparison
 * that reads the top level sees a record with no email, no name and
 * nothing to match on.
 *
 * This was invisible until the connector ran against a real HTTP server
 * returning real vendor shapes: every HubSpot contact came back
 * unmatchable and the report said the two systems shared no population,
 * which is a confident, well-formatted, completely wrong answer.
 */
const ENVELOPE_KEYS = ["properties", "fields", "data", "record"];

/** Vendor bookkeeping that is not the customer's data. */
const METADATA_KEYS = new Set(["attributes", "_links", "links", "meta"]);

/**
 * One record, flattened and lower-cased, with envelopes lifted.
 *
 * An envelope's own fields win over the outer ones, since the outer
 * level of a wrapped payload carries vendor bookkeeping and the inner
 * level carries what a person would call the record.
 */
function lower(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    const key = k.toLowerCase();
    if (METADATA_KEYS.has(key)) continue;
    if (ENVELOPE_KEYS.includes(key) && v && typeof v === "object" && !Array.isArray(v)) {
      for (const [ik, iv] of Object.entries(v as Record<string, unknown>)) {
        out[ik.toLowerCase()] = iv;
      }
      continue;
    }
    out[key] = v;
  }
  return out;
}

function firstString(r: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = r[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

/**
 * The identity we are willing to match on, or null.
 *
 * Email wins outright. A name is accepted only when it has at least two
 * parts, because matching every record called "Admin" together produces
 * a spectacular and entirely fictional drift report.
 */
export function matchKey(record: Record<string, unknown>): string | null {
  const r = lower(record);
  const email = firstString(r, EMAIL_KEYS);
  if (email) return `email:${email.toLowerCase()}`;

  const name =
    firstString(r, NAME_KEYS) ??
    [firstString(r, FIRST_KEYS), firstString(r, LAST_KEYS)]
      .filter(Boolean)
      .join(" ");
  const cleaned = name?.replace(/\s+/g, " ").trim().toLowerCase() ?? "";
  if (cleaned.split(" ").filter(Boolean).length < 2) return null;
  return `name:${cleaned}`;
}

/**
 * Are these the same answer written differently?
 *
 * Case and surrounding whitespace are formatting, not disagreement, and
 * a report full of "Acme Ltd vs acme ltd" is one nobody reads twice.
 * Numbers are compared numerically so 1000 and "1,000" agree. Empty and
 * absent are treated the same, since a system that has never held a
 * field and one that holds a blank are both "we don't know".
 */
export function sameValue(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): string | number | null => {
    if (v === null || v === undefined) return null;
    if (typeof v === "number") return v;
    if (typeof v === "boolean") return String(v);
    if (typeof v !== "string") return JSON.stringify(v);
    const t = v.trim();
    if (!t) return null;
    const numeric = Number(t.replace(/[,$\s]/g, ""));
    if (t !== "" && !Number.isNaN(numeric) && /^[\d,.$\s-]+$/.test(t)) return numeric;
    return t.toLowerCase();
  };
  return norm(a) === norm(b);
}

export interface FieldDrift {
  field: string;
  /** How many matched records disagree on this field. */
  disagreements: number;
  /** How many matched records hold the field on both sides. */
  comparable: number;
  /** One illustrative pair. The user's own data, never sent to analytics. */
  example?: { key: string; left: string; right: string };
}

export interface DriftReport {
  left: string;
  right: string;
  objectType: string;
  matched: number;
  onlyInLeft: number;
  onlyInRight: number;
  /** Records with neither an email nor a two-part name on either side. */
  unmatchable: number;
  /**
   * How many field names the two systems actually share.
   *
   * Without this, two CRMs that name every field differently produce
   * "no disagreements", which reads as agreement and is really "we
   * compared nothing". Same failure as a silent generator: an empty
   * result presented as a clean bill of health.
   */
  comparableFields: number;
  fields: FieldDrift[];
}

export function compareRecordSets(
  objectType: string,
  left: { name: string; records: Array<Record<string, unknown>> },
  right: { name: string; records: Array<Record<string, unknown>> },
): DriftReport {
  const index = (records: Array<Record<string, unknown>>) => {
    const byKey = new Map<string, Record<string, unknown>>();
    let unmatchable = 0;
    for (const rec of records) {
      const key = matchKey(rec);
      if (!key) {
        unmatchable++;
        continue;
      }
      /* First occurrence wins. A duplicate inside ONE system is a real
         problem, and a different one from drift between two; conflating
         them would report a system as disagreeing with itself. */
      if (!byKey.has(key)) byKey.set(key, rec);
    }
    return { byKey, unmatchable };
  };

  const l = index(left.records);
  const r = index(right.records);

  const drift = new Map<string, FieldDrift>();
  let matched = 0;

  for (const [key, lRec] of l.byKey) {
    const rRec = r.byKey.get(key);
    if (!rRec) continue;
    matched++;

    const lLow = lower(lRec);
    const rLow = lower(rRec);
    for (const field of new Set([...Object.keys(lLow), ...Object.keys(rLow)])) {
      if (IGNORED_FIELDS.has(field)) continue;
      const lv = lLow[field];
      const rv = rLow[field];
      /* Only compare where both sides have something to say. One system
         holding a field the other has never heard of is a schema
         difference, not a contradiction. */
      const bothPresent =
        lv !== undefined && lv !== null && lv !== "" &&
        rv !== undefined && rv !== null && rv !== "";
      if (!bothPresent) continue;

      const entry = drift.get(field) ?? { field, disagreements: 0, comparable: 0 };
      entry.comparable++;
      if (!sameValue(lv, rv)) {
        entry.disagreements++;
        if (!entry.example) {
          entry.example = { key, left: String(lv), right: String(rv) };
        }
      }
      drift.set(field, entry);
    }
  }

  const comparableFields = [...drift.values()].filter((f) => f.comparable > 0).length;
  const fields = [...drift.values()]
    .filter((f) => f.disagreements > 0)
    .sort((a, b) => b.disagreements - a.disagreements);

  return {
    objectType,
    left: left.name,
    right: right.name,
    matched,
    onlyInLeft: l.byKey.size - matched,
    onlyInRight: r.byKey.size - matched,
    unmatchable: l.unmatchable + r.unmatchable,
    comparableFields,
    fields,
  };
}

/**
 * The report as a person would say it.
 *
 * Ordered by what a reader can act on: the disagreements first, then
 * the records that exist in only one place, then the caveat about what
 * could not be lined up at all.
 */
export function renderDrift(report: DriftReport): string {
  const { left, right, objectType, matched } = report;
  if (matched === 0) {
    return (
      `No ${objectType} record in ${left} could be matched to one in ${right}. ` +
      `That is itself worth knowing: either they hold different populations, or ` +
      `they share no identifier we can match on.`
    );
  }

  const lines: string[] = [
    `Compared ${matched} ${objectType} records held in both ${left} and ${right}.`,
    "",
  ];

  if (report.comparableFields === 0) {
    lines.push(
      `The two systems share no field names, so nothing could be compared beyond identity. ` +
        `They hold the same people under different schemas, which is worth knowing on its own: ` +
        `any reconciliation between them needs a field mapping first.`,
    );
  } else if (report.fields.length === 0) {
    lines.push(
      `No disagreements across the ${report.comparableFields} fields both systems name. ` +
        `They agree everywhere they overlap.`,
    );
  } else {
    lines.push("**Where they disagree**");
    for (const f of report.fields.slice(0, 8)) {
      const pct = Math.round((f.disagreements / Math.max(1, f.comparable)) * 100);
      lines.push(
        `- \`${f.field}\`: ${f.disagreements} of ${f.comparable} disagree (${pct}%)` +
          (f.example
            ? `; e.g. ${left} says "${f.example.left}", ${right} says "${f.example.right}"`
            : ""),
      );
    }
  }

  if (report.onlyInLeft || report.onlyInRight) {
    lines.push("", "**Held in only one system**");
    if (report.onlyInLeft) lines.push(`- ${report.onlyInLeft} only in ${left}`);
    if (report.onlyInRight) lines.push(`- ${report.onlyInRight} only in ${right}`);
  }

  if (report.unmatchable) {
    lines.push(
      "",
      `${report.unmatchable} records had no email and no full name, so they could not ` +
        `be lined up either way and are excluded from the counts above.`,
    );
  }

  return lines.join("\n");
}
