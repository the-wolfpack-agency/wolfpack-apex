/**
 * STATIC, COMMITTED snapshot of public CISA Known Exploited Vulnerabilities
 * (KEV) catalog entries for the edge devices the classifier recognises
 * (firewall / SSL-VPN appliances). This is a frozen, hand-curated subset of the
 * public KEV catalog (https://www.cisa.gov/known-exploited-vulnerabilities-catalog)
 * - NOT a live download. The classifier is deterministic and offline by
 * construction: it never fetches the catalog at runtime, so the data it maps to
 * is exactly what is reviewed and committed here.
 *
 * WHY a committed snapshot and not a live feed:
 *   - Determinism: the same recognised product always maps to the same CVE set,
 *     so a finding is reproducible and reviewable without a network round-trip.
 *   - Supply-chain safety: no runtime HTTP dependency on an external catalog that
 *     could be unreachable, rate-limited, or tampered with mid-scan.
 *   - Precision: we map ONLY to KEV entries we have vetted for the specific
 *     product family, never a fuzzy keyword match against a huge live file.
 *
 * Refreshing: this file is updated by a committed change (a human reviews the new
 * KEV rows), the same way any other security corpus in platform-scan is bumped.
 * `snapshotDate` records when the subset was last curated.
 *
 * Fields mirror the public CISA KEV schema (cveID, vendorProject, product,
 * vulnerabilityName, dateAdded, knownRansomwareCampaignUse). All values below are
 * public, catalog-sourced facts; no target-specific or private data lives here.
 */

/** The date this curated subset was last reviewed against the public KEV catalog. */
export const KEV_SNAPSHOT_DATE = "2026-10-01";

/** One CISA KEV catalog entry (public fields only). */
export interface KevEntry {
  /** CVE identifier, e.g. "CVE-2024-21762". */
  cveId: string;
  /** Vendor/project as named in the catalog. */
  vendorProject: string;
  /** Product as named in the catalog. */
  product: string;
  /** Short public vulnerability name from the catalog. */
  vulnerabilityName: string;
  /** Date CISA added the entry to the KEV catalog (ISO date). */
  dateAdded: string;
  /** CISA's "Known to be used in ransomware campaigns" flag. */
  knownRansomware: boolean;
}

/**
 * KEV entries keyed by the canonical product key used in fingerprints.ts. Each
 * array is a vetted, product-specific subset. Keeping the map keyed by product
 * (not CVE) means the classifier maps a recognised product to its CVE set in O(1)
 * with no fuzzy matching.
 */
export const KEV_BY_PRODUCT: Record<string, KevEntry[]> = {
  fortinet_fortios_sslvpn: [
    {
      cveId: "CVE-2024-21762",
      vendorProject: "Fortinet",
      product: "FortiOS",
      vulnerabilityName: "Fortinet FortiOS Out-of-Bound Write Vulnerability",
      dateAdded: "2024-02-09",
      knownRansomware: false,
    },
    {
      cveId: "CVE-2023-27997",
      vendorProject: "Fortinet",
      product: "FortiOS/FortiProxy",
      vulnerabilityName: "Fortinet FortiOS and FortiProxy Heap-Based Buffer Overflow Vulnerability",
      dateAdded: "2023-08-04",
      knownRansomware: false,
    },
    {
      cveId: "CVE-2022-42475",
      vendorProject: "Fortinet",
      product: "FortiOS",
      vulnerabilityName: "Fortinet FortiOS Heap-Based Buffer Overflow Vulnerability",
      dateAdded: "2022-12-13",
      knownRansomware: true,
    },
  ],
  ivanti_connect_secure: [
    {
      cveId: "CVE-2025-0282",
      vendorProject: "Ivanti",
      product: "Connect Secure, Policy Secure, and ZTA Gateways",
      vulnerabilityName: "Ivanti Connect Secure Stack-Based Buffer Overflow Vulnerability",
      dateAdded: "2025-01-08",
      knownRansomware: false,
    },
    {
      cveId: "CVE-2024-21887",
      vendorProject: "Ivanti",
      product: "Connect Secure and Policy Secure",
      vulnerabilityName: "Ivanti Connect Secure and Policy Secure Command Injection Vulnerability",
      dateAdded: "2024-01-10",
      knownRansomware: true,
    },
    {
      cveId: "CVE-2023-46805",
      vendorProject: "Ivanti",
      product: "Connect Secure and Policy Secure",
      vulnerabilityName: "Ivanti Connect Secure and Policy Secure Authentication Bypass Vulnerability",
      dateAdded: "2024-01-10",
      knownRansomware: true,
    },
  ],
  citrix_netscaler_gateway: [
    {
      cveId: "CVE-2023-4966",
      vendorProject: "Citrix",
      product: "NetScaler ADC and NetScaler Gateway",
      vulnerabilityName: "Citrix NetScaler ADC and Gateway Buffer Overflow Vulnerability",
      dateAdded: "2023-10-18",
      knownRansomware: true,
    },
    {
      cveId: "CVE-2023-3519",
      vendorProject: "Citrix",
      product: "NetScaler ADC and NetScaler Gateway",
      vulnerabilityName: "Citrix NetScaler ADC and Gateway Code Injection Vulnerability",
      dateAdded: "2023-07-19",
      knownRansomware: true,
    },
  ],
  paloalto_globalprotect: [
    {
      cveId: "CVE-2024-3400",
      vendorProject: "Palo Alto Networks",
      product: "PAN-OS",
      vulnerabilityName: "Palo Alto Networks PAN-OS Command Injection Vulnerability",
      dateAdded: "2024-04-12",
      knownRansomware: true,
    },
  ],
  sonicwall_sslvpn: [
    {
      cveId: "CVE-2024-40766",
      vendorProject: "SonicWall",
      product: "SonicOS",
      vulnerabilityName: "SonicWall SonicOS Improper Access Control Vulnerability",
      dateAdded: "2024-09-09",
      knownRansomware: true,
    },
    {
      cveId: "CVE-2021-20016",
      vendorProject: "SonicWall",
      product: "SMA100 Appliances",
      vulnerabilityName: "SonicWall SSLVPN SMA100 SQL Injection Vulnerability",
      dateAdded: "2021-11-03",
      knownRansomware: true,
    },
  ],
  cisco_asa_webvpn: [
    {
      cveId: "CVE-2023-20269",
      vendorProject: "Cisco",
      product: "Adaptive Security Appliance (ASA) and Firepower Threat Defense (FTD)",
      vulnerabilityName: "Cisco ASA and FTD Unauthorized Access Vulnerability",
      dateAdded: "2023-09-11",
      knownRansomware: true,
    },
  ],
};

/** Return the committed KEV subset for a product key (empty array if none). */
export function kevForProduct(product: string): KevEntry[] {
  return KEV_BY_PRODUCT[product] ?? [];
}
