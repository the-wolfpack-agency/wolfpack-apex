/**
 * Validation-coverage taxonomy for the platform-scan command center.
 *
 * Pure data: a typed, client-facing map of WHAT the platform-scan agent
 * actually tests, expressed as (system area -> type of testing -> what each
 * validates). The /admin/platform-scans page renders this as the "What we
 * tested" grid so a client can understand, in plain language, how broad the
 * scan that just ran really is.
 *
 * Grounded in the REAL platform-scan modalities (see src/lib/platform-scan):
 *   - dynamic crawl of the live site,
 *   - static source analysis,
 *   - API / contract checks,
 *   - browser-level UX + accessibility audit,
 *   - active + passive security probing,
 *   - user-journey simulation,
 *   - data / tenant-integrity + audit-chain checks,
 *   - continuous self-benchmark (detection vs known-vulnerable targets and
 *     vs leading scanners).
 *
 * HARD RULE: no tool names, no brand names, no product names anywhere in this
 * file's copy. Only the platform's own capabilities described in plain
 * language. The taxonomy test asserts this stays true.
 */

export interface TestingTaxonomyEntry {
  /** The system area under test, in client-facing language. */
  area: string;
  /** The type / modality of testing applied to that area. */
  testingType: string;
  /** What that testing concretely validates for the client. */
  validates: string;
}

/**
 * The coverage map. Lean (8-12 rows), confident, true. Ordered roughly from
 * the live surface inward to the data and the self-checks, so a reader walks
 * from "what they see" to "what we guarantee underneath."
 */
export const TESTING_TAXONOMY: readonly TestingTaxonomyEntry[] = [
  {
    area: "Live pages and routes",
    testingType: "Dynamic crawl of the running site",
    validates:
      "Every reachable page loads, returns a healthy response, and renders real content instead of an error or a blank screen.",
  },
  {
    area: "Source and configuration",
    testingType: "Static source analysis",
    validates:
      "Risky patterns, misconfigurations, and unsafe defaults are caught in the code itself, before they ever reach a user.",
  },
  {
    area: "Data and service interfaces",
    testingType: "Interface and contract checks",
    validates:
      "Each interface accepts what it should, rejects what it should not, and returns the shape and status its callers depend on.",
  },
  {
    area: "Usability and experience",
    testingType: "Browser-level experience audit",
    validates:
      "Pages are clear and usable: controls fit, content is readable, and nothing is cut off or hidden across screen sizes.",
  },
  {
    area: "Accessibility",
    testingType: "Browser-level accessibility audit",
    validates:
      "The product can be operated with a keyboard and a screen reader, with sufficient contrast and proper labels and structure.",
  },
  {
    area: "Security posture",
    testingType: "Passive security inspection",
    validates:
      "Protective response headers, transport security, and safe defaults are present and configured the way they should be.",
  },
  {
    area: "Security resilience",
    testingType: "Active security probing",
    validates:
      "Common attack patterns against inputs and endpoints are attempted safely and confirmed to be refused, not exploited.",
  },
  {
    area: "Authentication and access",
    testingType: "Access-control checks",
    validates:
      "Protected areas require a valid session and unauthenticated visitors are redirected, never shown data they should not see.",
  },
  {
    area: "Core user journeys",
    testingType: "End-to-end journey simulation",
    validates:
      "Key tasks a real user performs complete from start to finish without breaking, erroring, or stranding the user midway.",
  },
  {
    area: "Data and tenant integrity",
    testingType: "Integrity and audit-trail checks",
    validates:
      "Each account sees only its own data, records are not silently altered, and the tamper-evident activity log stays intact.",
  },
  {
    area: "Detection quality",
    testingType: "Continuous self-benchmark",
    validates:
      "Detection is measured against known-vulnerable references and against leading detection standards, so coverage is proven, not assumed.",
  },
];

export default TESTING_TAXONOMY;
