/**
 * Types for the bundled CISA Known Exploited Vulnerabilities (KEV) snapshot.
 *
 * The snapshot holds ONLY the KEV entries this codebase references (the
 * Forcefield CVE probe rules and the platform-scan edge-device product map),
 * copied field-for-field from CISA's public feed by scripts/kev-refresh.ts.
 * Nothing here is fetched at runtime.
 */

/** One KEV catalog entry (public catalog fields only). */
export interface KevEntry {
  cveId: string;
  vendorProject: string;
  product: string;
  vulnerabilityName: string;
  /** ISO date CISA added the entry. */
  dateAdded: string;
  /** CISA "knownRansomwareCampaignUse" === "Known". */
  knownRansomware: boolean;
}

export interface KevSnapshot {
  /** The public feed the snapshot was built from. */
  source: string;
  /** The feed's catalogVersion at refresh time, e.g. "2026.10.23". */
  catalogVersion: string;
  /** The feed's dateReleased at refresh time (ISO timestamp). */
  dateReleased: string;
  /** Tracked entries keyed by CVE id, sorted by id. */
  entries: Readonly<Record<string, KevEntry>>;
}
