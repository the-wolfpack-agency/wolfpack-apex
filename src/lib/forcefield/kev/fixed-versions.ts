/**
 * Fixed-version data for the tracked KEV entries that a site's own server
 * software can carry: PHP itself and WordPress plugins.
 *
 * CISA's KEV feed names the flaw but not the release that fixes it, so the
 * fixed versions live here, each checked against the primary source cited on
 * the rule (vendor advisory or the NVD record's CPE configuration), keyed
 * to CVE ids that MUST be in the bundled KEV snapshot (pinned by
 * __tests__/fixed-versions.test.ts). The WordPress plugin's server inventory is
 * matched against these rules by forcefield-web/server-exposure.ts.
 *
 * A rule only ever supports a CERTAIN answer:
 *   - `branches`: per release line (major.minor), the first fixed release.
 *     A version on a listed line below its fixed release is exposed; at or
 *     above it is fixed.
 *   - `unsupportedBelow`: release lines older than this get no fixes at all
 *     from the vendor, so any version on them is exposed.
 *   - A line newer than every listed one is NOT assumed fixed: it reports
 *     "could not check" until the data here names it.
 *   - `affectedFrom`: the first release the advisory says carries the flaw.
 *     Below it the advisory says nothing certain, so it reports "could not
 *     check" rather than safe.
 * Pure data; no network, no model.
 */

export type FixedVersionProduct = "php" | "wordpress_plugin";

export interface FixedVersionBranch {
  /** Release line, "major.minor" (e.g. "8.4"). */
  line: string;
  /** First fixed release on that line (e.g. "8.4.27"). */
  fixed: string;
}

export interface FixedVersionRule {
  /** Stable id, used in exposure keys and analytics. */
  id: string;
  product: FixedVersionProduct;
  /** WordPress plugin slug (the plugin folder name), for product "wordpress_plugin". */
  slug?: string;
  /** Display name of the product ("PHP", "File Manager plugin"). */
  productName: string;
  /** CVE ids in the bundled KEV snapshot this rule covers. */
  cves: readonly string[];
  /** The flaw in plain language, for the owner. */
  plainName: string;
  /** What the flaw lets an attacker do, one short clause. */
  impact: string;
  /** Per-line fixed releases (PHP), or a single line-agnostic fix (plugins). */
  branches?: readonly FixedVersionBranch[];
  /** Line-agnostic first fixed release (plugins). */
  fixed?: string;
  /** Lines older than this ("major.minor") are out of vendor support: exposed. */
  unsupportedBelow?: string;
  /** First release the advisory says is affected; below it = could not check. */
  affectedFrom?: string;
  /** Who fixes it, in one line, for the owner. "{fixed}" is replaced. */
  howToFix: string;
}

export const FIXED_VERSION_RULES: readonly FixedVersionRule[] = [
  {
    id: "php2shell",
    product: "php",
    productName: "PHP",
    cves: ["CVE-2026-109618", "CVE-2026-109619"],
    plainName: "PHP2Shell, PHP server takeover",
    impact: "a single crafted request can take over the server before WordPress or any plugin runs",
    branches: [
      { line: "8.5", fixed: "8.5.12" },
      { line: "8.4", fixed: "8.4.27" },
      { line: "8.3", fixed: "8.3.36" },
      { line: "8.2", fixed: "8.2.35" },
    ],
    unsupportedBelow: "8.2",
    howToFix: "Your hosting company updates PHP. Ask them to move this site to PHP {fixed} or later; many hosting control panels also have a PHP version setting.",
  },
  {
    id: "wp_file_manager_rce",
    product: "wordpress_plugin",
    slug: "wp-file-manager",
    productName: "File Manager plugin",
    cves: ["CVE-2020-25213"],
    plainName: "File Manager plugin remote code execution",
    impact: "anyone on the internet can upload and run their own code on the server",
    // NVD CVE-2020-25213 (checked 2026-10-27): "plugin before 6.9"; CPE
    // versionEndExcluding 6.9 with no lower bound, so no affectedFrom.
    // https://nvd.nist.gov/vuln/detail/CVE-2020-25213
    fixed: "6.9",
    howToFix: "Update File Manager to {fixed} or later under Plugins in WordPress, or remove it. Your developer or host can do this for you.",
  },
  {
    id: "duplicator_file_download",
    product: "wordpress_plugin",
    slug: "duplicator",
    productName: "Duplicator plugin",
    cves: ["CVE-2020-11738"],
    plainName: "Duplicator plugin file download",
    impact: "anyone on the internet can download files from the server, including the database password",
    // NVD CVE-2020-11738 (checked 2026-10-27): Duplicator (lite, slug
    // "duplicator") before 1.3.28; CPE versionEndExcluding 1.3.28. Duplicator
    // Pro (fixed 3.8.7.1) is a separate, non-wordpress.org plugin, not matched.
    // https://nvd.nist.gov/vuln/detail/CVE-2020-11738
    fixed: "1.3.28",
    howToFix: "Update Duplicator to {fixed} or later under Plugins in WordPress. Your developer or host can do this for you.",
  },
  {
    id: "social_warfare_xss",
    product: "wordpress_plugin",
    slug: "social-warfare",
    productName: "Social Warfare plugin",
    cves: ["CVE-2019-9978"],
    plainName: "Social Warfare plugin script injection",
    impact: "anyone on the internet can plant scripts that run in your visitors' browsers",
    // NVD CVE-2019-9978 (checked 2026-10-27): "social-warfare plugin before
    // 3.5.3 ... stored XSS ... exploited in the wild"; CPE versionEndExcluding
    // 3.5.3 with no lower bound, so no affectedFrom.
    // https://nvd.nist.gov/vuln/detail/CVE-2019-9978
    fixed: "3.5.3",
    howToFix: "Update Social Warfare to {fixed} or later under Plugins in WordPress. Your developer or host can do this for you.",
  },
];

/** Every CVE id the fixed-version rules name (all must be in the KEV snapshot). */
export const FIXED_VERSION_CVES: readonly string[] = [...new Set(FIXED_VERSION_RULES.flatMap((r) => r.cves))].sort();
