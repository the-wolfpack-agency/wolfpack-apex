/**
 * The bundled CISA KEV snapshot and the deterministic lookups over it.
 *
 * One source for KEV facts: the Forcefield event annotation (annotateKevProps)
 * and the platform-scan edge-device classifier both read the same generated
 * snapshot. Pure lookups, no network, no model.
 */
import { KEV_SNAPSHOT } from "./catalog.generated";
import type { KevEntry } from "./types";
import { kevCveFor } from "@/lib/forcefield-web/kev-rules";

export { KEV_SNAPSHOT };
export type { KevEntry, KevSnapshot } from "./types";

/** The KEV entry for a CVE id, or null when it is not in the snapshot. */
export function kevEntry(cveId: string): KevEntry | null {
  return KEV_SNAPSHOT.entries[(cveId ?? "").trim().toUpperCase()] ?? null;
}

/** The snapshot's catalog date (YYYY-MM-DD), for findings and the panel. */
export function kevSnapshotDate(): string {
  return KEV_SNAPSHOT.dateReleased.slice(0, 10);
}

/** Props a client could send to fake an annotation. Always stripped and then
 *  re-derived server-side from the probe / attack label. */
export const KEV_PROP_KEYS = ["cve", "kev", "kev_added", "kev_ransomware", "kev_catalog"] as const;

/** Event types that describe a hostile request (the only ones annotated). */
const ANNOTATED_TYPES = new Set([
  "site.agent_probed_sensitive",
  "site.agent_payload_attack",
  "site.agent_flagged",
  "site.agent_trap_tripped",
]);

/**
 * Annotate a Forcefield event's props with the CVE its request targeted and that
 * CVE's KEV status. Deterministic: the CVE comes from the engine's own probe /
 * attack label (kev-rules.ts), the status from the bundled snapshot. Client-sent
 * cve/kev props are removed first, so a vendored site cannot forge one. Returns
 * a new object; never throws.
 */
export function annotateKevProps(
  eventType: string,
  props: Record<string, string | number | boolean> | undefined,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = { ...(props ?? {}) };
  for (const k of KEV_PROP_KEYS) delete out[k];
  try {
    if (!ANNOTATED_TYPES.has(eventType)) return out;
    const cve = kevCveFor(out.probe, out.attack);
    if (!cve) return out;
    const entry = kevEntry(cve);
    out.cve = cve;
    out.kev = entry !== null;
    if (entry) {
      out.kev_added = entry.dateAdded;
      out.kev_ransomware = entry.knownRansomware;
      out.kev_catalog = KEV_SNAPSHOT.catalogVersion;
    }
  } catch {
    /* annotation is enrichment only; the event still records */
  }
  return out;
}
