/**
 * Edge-device product -> CISA Known Exploited Vulnerabilities (KEV) mapping.
 *
 * The product map below names WHICH KEV CVEs belong to each appliance family the
 * classifier recognises. The catalog FACTS for each CVE (vendor, product name,
 * dateAdded, ransomware use) are not typed here: they come from the generated,
 * checked-in snapshot of CISA's public feed (src/lib/forcefield/kev/
 * catalog.generated.ts), refreshed by `npm run kev:refresh` and drift-checked by
 * `npm run kev:check`. Nothing is fetched at runtime, so the classifier stays
 * deterministic and offline: the same recognised product always maps to the same
 * reviewed CVE set.
 *
 * Every id in EDGE_PRODUCT_CVES must exist in the snapshot. The refresh script
 * refuses to write a snapshot when a tracked id is missing from the live feed,
 * and a jest test fails when an id is missing from the checked-in snapshot.
 */
import { KEV_SNAPSHOT, kevEntry, kevSnapshotDate, type KevEntry } from "@/lib/forcefield/kev";

export type { KevEntry };

/** The catalog date of the bundled KEV snapshot (YYYY-MM-DD). */
export const KEV_SNAPSHOT_DATE = kevSnapshotDate();

/** The catalogVersion of the bundled KEV snapshot (e.g. "2026.10.23"). */
export const KEV_CATALOG_VERSION = KEV_SNAPSHOT.catalogVersion;

/**
 * KEV CVE ids per canonical product key (the keys fingerprints.ts uses). A
 * vetted, product-specific subset; never a keyword match over the whole feed.
 */
export const EDGE_PRODUCT_CVES: Readonly<Record<string, readonly string[]>> = {
  fortinet_fortios_sslvpn: ["CVE-2024-21762", "CVE-2023-27997", "CVE-2022-42475"],
  ivanti_connect_secure: ["CVE-2025-0282", "CVE-2024-21887", "CVE-2023-46805"],
  citrix_netscaler_gateway: ["CVE-2023-4966", "CVE-2023-3519"],
  paloalto_globalprotect: ["CVE-2024-3400"],
  sonicwall_sslvpn: ["CVE-2024-40766", "CVE-2021-20016"],
  cisco_asa_webvpn: ["CVE-2023-20269"],
};

/** Every CVE id the edge-device map references (the KEV refresh tracks these). */
export const EDGE_EXPOSURE_KEV_CVES: readonly string[] = [
  ...new Set(Object.values(EDGE_PRODUCT_CVES).flat()),
].sort();

/** Product key -> KEV entries, resolved from the snapshot. An id missing from
 *  the snapshot is dropped (and fails the snapshot-coverage test). */
export const KEV_BY_PRODUCT: Readonly<Record<string, KevEntry[]>> = Object.fromEntries(
  Object.entries(EDGE_PRODUCT_CVES).map(([product, ids]) => [
    product,
    ids.map((id) => kevEntry(id)).filter((e): e is KevEntry => e !== null),
  ]),
);

/** The KEV entries for a product key (empty array if none). */
export function kevForProduct(product: string): KevEntry[] {
  return KEV_BY_PRODUCT[product] ?? [];
}
