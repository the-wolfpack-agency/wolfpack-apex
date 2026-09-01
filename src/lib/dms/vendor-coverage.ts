/**
 * What each dealer system can actually tell us, declared rather than assumed.
 *
 * THE QUESTION THIS EXISTS TO ANSWER. Our client's dealers run at least three
 * different dealer management systems. Whether that is a week of work or a
 * quarter depends entirely on how much of each one has to be rebuilt rather
 * than mapped, and nobody could say, because there was one vendor and no way
 * to express what a second would cost.
 *
 * WHAT THE CURRENT SHAPE ACTUALLY IS. The canonical record is title, year,
 * make, model, price, VIN, an image and a link. That is a WEBSITE LISTING,
 * because the one implemented vendor is a public inventory page that is
 * scraped. A real dealer management system is a credentialed API holding
 * things a listing never shows: what the vehicle cost, how long it has been on
 * the lot, its stock number, whether it is in transit or already sold.
 *
 * Those fields are deliberately NOT invented here. Which of them a dealer
 * actually needs is a question for the dealers, and a schema guessed by
 * somebody who has never worked a lot would be confidently wrong in a way that
 * is expensive to unpick later. What this file does is make the gap VISIBLE
 * and MEASURABLE, so the answer to "how much adjustment per system" is a
 * number rather than an opinion.
 *
 * THE THREE MEANINGS OF AN EMPTY FIELD, which this product keeps having to
 * separate. A null price can mean the vendor does not expose price, or that it
 * does and this vehicle has none, or that the call failed. To a dealer those
 * are completely different, and rendering all three as a blank cell is how a
 * report gets quietly disbelieved. Coverage is declared per vendor so the
 * first can always be told from the others.
 */

import type { DmsInventoryItem } from "@/lib/assistant/widgets/types";

/** Every field the inventory widget can render. */
export type CanonicalField = keyof DmsInventoryItem;

export const CANONICAL_FIELDS: CanonicalField[] = [
  "title",
  "year",
  "make",
  "model",
  "price",
  "vin",
  "imageUrl",
  "detailUrl",
];

export interface VendorCoverage {
  vendor: string;
  label: string;
  /** Canonical fields this vendor supplies. */
  provides: CanonicalField[];
  /**
   * How we reach it. A scraped listing and a credentialed API fail
   * differently and cost differently to add, and the distinction is the first
   * thing anybody estimating the work needs.
   */
  access: "public-listing" | "credentialed-api" | "not-mapped";
  /** Said plainly, for whoever is scoping the next one. */
  note: string;
}

/**
 * Vendors, and what each is known to provide.
 *
 * Only wolfpack-auto is filled in, because it is the only one implemented and
 * its coverage was read from its driver rather than assumed. The others are
 * listed as not mapped ON PURPOSE: an empty row is the honest statement of
 * outstanding work, and leaving them out entirely would make the report look
 * finished.
 */
export const VENDOR_COVERAGE: VendorCoverage[] = [
  {
    vendor: "wolfpack-auto",
    label: "Wolfpack Auto",
    provides: ["title", "year", "make", "model", "price", "vin", "imageUrl", "detailUrl"],
    access: "public-listing",
    note: "A public inventory page, read with a browser because a plain fetch returns no listings. It shows what a shopper sees, so nothing about cost, age on the lot or stock status is available from it at any price.",
  },
  {
    vendor: "cdk",
    label: "CDK",
    provides: [],
    access: "not-mapped",
    note: "Not mapped. Reached by credentialed API rather than a page, so the work is credentials and field mapping rather than scraping.",
  },
  {
    vendor: "reynolds",
    label: "Reynolds and Reynolds",
    provides: [],
    access: "not-mapped",
    note: "Not mapped.",
  },
  {
    vendor: "tekion",
    label: "Tekion",
    provides: [],
    access: "not-mapped",
    note: "Not mapped.",
  },
];

export function coverageFor(vendor: string): VendorCoverage | null {
  return VENDOR_COVERAGE.find((v) => v.vendor === vendor.toLowerCase()) ?? null;
}

/** Canonical fields this vendor cannot supply, whatever the vehicle. */
export function unsupportedFields(vendor: string): CanonicalField[] {
  const cov = coverageFor(vendor);
  if (!cov) return [...CANONICAL_FIELDS];
  return CANONICAL_FIELDS.filter((f) => !cov.provides.includes(f));
}

/**
 * Is this blank because the vendor cannot say, or because there is no value?
 *
 * The distinction a dealer needs and the one a blank cell destroys.
 */
export function whyEmpty(
  vendor: string,
  field: CanonicalField,
): "vendor-cannot-supply" | "no-value-for-this-vehicle" {
  return unsupportedFields(vendor).includes(field)
    ? "vendor-cannot-supply"
    : "no-value-for-this-vehicle";
}

export interface CoverageReading {
  vendor: string;
  label: string;
  access: VendorCoverage["access"];
  provided: number;
  total: number;
  missing: CanonicalField[];
}

export function readCoverage(): CoverageReading[] {
  return VENDOR_COVERAGE.map((v) => ({
    vendor: v.vendor,
    label: v.label,
    access: v.access,
    provided: v.provides.length,
    total: CANONICAL_FIELDS.length,
    missing: unsupportedFields(v.vendor),
  }));
}

/**
 * One sentence for a dealer, when a vendor cannot answer part of the question.
 *
 * Names the system rather than apologizing, because a dealer knows which one
 * they run and "your DMS does not expose that through this connection" is
 * actionable where "unavailable" is not.
 */
export function describeGap(vendor: string, wanted: CanonicalField[]): string | null {
  const missing = wanted.filter((f) => unsupportedFields(vendor).includes(f));
  if (missing.length === 0) return null;
  const cov = coverageFor(vendor);
  const who = cov?.label ?? vendor;
  return `${who} does not expose ${missing.join(", ")} through this connection, so those are blank rather than empty.`;
}
