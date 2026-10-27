/**
 * "Is your server exposed?": match a site's server inventory (reported by the
 * WordPress plugin: PHP version, WordPress version, active plugins) against the
 * fixed-version data for the actively exploited flaws Forcefield tracks
 * (forcefield/kev/fixed-versions.ts, CVEs from the bundled CISA KEV snapshot).
 *
 * Why this exists: some flaws, PHP2Shell among them, trigger inside PHP itself
 * before any plugin runs, so no plugin can block them. What a plugin CAN do is
 * tell the owner, early and plainly, that their server runs a version that is
 * open to one, and who fixes it.
 *
 * Certainty rule: a finding says "exposed" or "up to date" only when the version
 * comparison is certain. Anything else (an unreadable version, a pre-release, a
 * Linux-distribution build that may carry a backported fix, a release line the
 * data does not name yet) is "could not check", never safe and never exposed.
 *
 * Pure and deterministic: no IO, no model. Safe in the client bundle (types).
 */
import { FIXED_VERSION_RULES, type FixedVersionRule } from "@/lib/forcefield/kev/fixed-versions";
import { kevEntry, kevSnapshotDate } from "@/lib/forcefield/kev";

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

export interface ParsedVersion {
  /** Numeric segments, e.g. [8, 3, 10]. */
  parts: number[];
  /** "release" = plain numbers only; "distro" = a vendor build suffix
   *  (8.1.2-1ubuntu2.20, 8.2.7+deb12u1); "prerelease" = RC / alpha / beta / dev. */
  kind: "release" | "distro" | "prerelease";
  raw: string;
}

const MAX_VERSION_LEN = 40;
const NUMERIC = /^(\d{1,4}(?:\.\d{1,6}){0,4})(.*)$/;
const PRERELEASE = /^[-.~]?(rc|alpha|beta|dev|preview|pre|a|b)\d*(?:[-.+~]|$)/i;

/** Parse a version string; null when it does not start with "major.minor". */
export function parseVersion(raw: unknown): ParsedVersion | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  if (!v || v.length > MAX_VERSION_LEN) return null;
  const m = NUMERIC.exec(v);
  if (!m) return null;
  const parts = m[1].split(".").map((n) => Number(n));
  if (parts.length < 2 || parts.some((n) => !Number.isFinite(n))) return null;
  const rest = m[2];
  if (!rest) return { parts, kind: "release", raw: v };
  if (PRERELEASE.test(rest)) return { parts, kind: "prerelease", raw: v };
  if (/^[-+~][0-9A-Za-z.+~-]+$/.test(rest)) return { parts, kind: "distro", raw: v };
  return null;
}

/** Plugin versions are vendor-defined: accept "1", "1.2", "1.2.3.4" (plain numbers only). */
export function parsePluginVersion(raw: unknown): ParsedVersion | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim();
  if (!/^\d{1,6}(?:\.\d{1,6}){0,4}$/.test(v)) return null;
  return { parts: v.split(".").map(Number), kind: "release", raw: v };
}

/** Numeric segment-wise comparison; missing segments are 0 (6.9 == 6.9.0). */
export function compareParts(a: readonly number[], b: readonly number[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

const partsOf = (s: string) => s.split(".").map(Number);
export const lineOf = (p: ParsedVersion) => `${p.parts[0]}.${p.parts[1]}`;

// ---------------------------------------------------------------------------
// One rule against one installed version
// ---------------------------------------------------------------------------

export type RuleVerdict =
  | { state: "exposed"; fixed: string; unsupportedLine?: string }
  | { state: "fixed"; fixed: string }
  | { state: "unknown"; reason: UnknownReason; fixed?: string };

export type UnknownReason =
  | "no_version"
  | "unreadable_version"
  | "prerelease"
  | "distro_build"
  | "line_not_tracked"
  | "older_than_advisory";

/** The plain-words explanation for each "could not check". */
export const UNKNOWN_TEXT: Record<UnknownReason, string> = {
  no_version: "The version was not reported.",
  unreadable_version: "The version could not be read.",
  prerelease: "This is a test (pre-release) build, so the fix cannot be confirmed from the version.",
  distro_build: "This is a Linux distribution build. Distributions often add security fixes without changing the version number, so ask your host whether this fix is included.",
  line_not_tracked: "This release line is newer than the fix data Forcefield holds, so it cannot be confirmed yet.",
  older_than_advisory: "This version is older than the releases the security advisory covers, so it cannot be confirmed either way.",
};

export function evaluateRule(rule: FixedVersionRule, rawVersion: unknown): RuleVerdict {
  if (rawVersion === undefined || rawVersion === null || rawVersion === "") return { state: "unknown", reason: "no_version" };
  if (rule.product === "php") return evaluateLines(rule, parseVersion(rawVersion));
  return evaluateSingleFix(rule, parsePluginVersion(rawVersion));
}

function evaluateLines(rule: FixedVersionRule, v: ParsedVersion | null): RuleVerdict {
  if (!v) return { state: "unknown", reason: "unreadable_version" };
  const branches = rule.branches ?? [];
  const line = lineOf(v);
  const lowestFixed = [...branches].sort((a, b) => compareParts(partsOf(a.fixed), partsOf(b.fixed)))[0]?.fixed;
  if (rule.unsupportedBelow && compareParts(partsOf(line), partsOf(rule.unsupportedBelow)) < 0) {
    // Out of vendor support: no upstream fix exists for this line. A
    // distribution build may still carry a backport, so it is not certain.
    if (v.kind !== "release") return { state: "unknown", reason: v.kind === "distro" ? "distro_build" : "prerelease", fixed: lowestFixed };
    return { state: "exposed", fixed: lowestFixed ?? rule.unsupportedBelow, unsupportedLine: line };
  }
  const branch = branches.find((b) => b.line === line);
  if (!branch) return { state: "unknown", reason: "line_not_tracked" };
  if (v.kind === "prerelease") return { state: "unknown", reason: "prerelease", fixed: branch.fixed };
  if (compareParts(v.parts, partsOf(branch.fixed)) >= 0) return { state: "fixed", fixed: branch.fixed };
  if (v.kind === "distro") return { state: "unknown", reason: "distro_build", fixed: branch.fixed };
  return { state: "exposed", fixed: branch.fixed };
}

function evaluateSingleFix(rule: FixedVersionRule, v: ParsedVersion | null): RuleVerdict {
  const fixed = rule.fixed ?? "";
  if (!v) return { state: "unknown", reason: "unreadable_version", fixed };
  if (rule.affectedFrom && compareParts(v.parts, partsOf(rule.affectedFrom)) < 0) return { state: "unknown", reason: "older_than_advisory", fixed };
  if (compareParts(v.parts, partsOf(fixed)) >= 0) return { state: "fixed", fixed };
  return { state: "exposed", fixed };
}

// ---------------------------------------------------------------------------
// The report for a whole inventory
// ---------------------------------------------------------------------------

export interface ServerInventory {
  phpVersion: string | null;
  wordpressVersion: string | null;
  serverSoftware: string | null;
  plugins: { slug: string; version: string | null }[];
  pluginVersion?: string | null;
}

export type ExposureState = "exposed" | "ok" | "unknown";

export interface ServerFinding {
  /** Stable key for alert dedupe: rule id + product. */
  key: string;
  ruleId: string | null;
  product: "php" | "wordpress" | "wordpress_plugin";
  productName: string;
  installed: string | null;
  state: ExposureState;
  /** The flaw in plain language (null when no tracked flaw applies). */
  flaw: string | null;
  impact: string | null;
  cves: string[];
  fixedVersion: string | null;
  /** One line: who fixes it and how. */
  howToFix: string | null;
  /** The owner-facing sentence for this row. */
  summary: string;
  /** For "could not check": why. */
  reason: UnknownReason | null;
}

export interface ServerExposureReport {
  status: ExposureState;
  findings: ServerFinding[];
  /** Active plugins with no tracked actively exploited flaw. */
  otherPlugins: number;
  serverSoftware: string | null;
  kevCatalogDate: string;
}

function findingFromRule(rule: FixedVersionRule, installed: string | null, product: ServerFinding["product"]): ServerFinding {
  const verdict = evaluateRule(rule, installed);
  const key = `${rule.id}:${rule.slug ?? rule.product}`;
  const cves = rule.cves.filter((c) => kevEntry(c) !== null);
  const label = `${rule.productName}${installed ? ` ${installed}` : ""}`;
  const base = { key, ruleId: rule.id, product, productName: rule.productName, installed, flaw: rule.plainName, impact: rule.impact, cves };
  if (verdict.state === "exposed") {
    const fixText = rule.howToFix.replace("{fixed}", verdict.fixed);
    const howToFix = verdict.unsupportedLine
      ? `${rule.productName} ${verdict.unsupportedLine} no longer gets security fixes. ${fixText}`
      : fixText;
    return {
      ...base,
      state: "exposed",
      fixedVersion: verdict.fixed,
      howToFix,
      summary: `Your server runs ${label}, which is open to ${rule.plainName}: ${rule.impact}.`,
      reason: null,
    };
  }
  if (verdict.state === "fixed") {
    return { ...base, state: "ok", fixedVersion: verdict.fixed, howToFix: null, summary: `${label} includes the fix for ${rule.plainName}.`, reason: null };
  }
  return {
    ...base,
    state: "unknown",
    fixedVersion: verdict.fixed ?? null,
    howToFix: verdict.fixed ? rule.howToFix.replace("{fixed}", verdict.fixed) : null,
    summary: `Could not check ${label} for ${rule.plainName}. ${UNKNOWN_TEXT[verdict.reason]}`,
    reason: verdict.reason,
  };
}

/** Build the owner-facing report. Deterministic for a given inventory and rule set. */
export function buildExposureReport(inv: ServerInventory, rules: readonly FixedVersionRule[] = FIXED_VERSION_RULES): ServerExposureReport {
  const findings: ServerFinding[] = [];
  for (const rule of rules.filter((r) => r.product === "php")) findings.push(findingFromRule(rule, inv.phpVersion, "php"));

  // WordPress core: no tracked actively exploited flaw affects core itself, so a
  // readable version is "ok"; an unreadable one is "could not check".
  const wp = inv.wordpressVersion ? parseVersion(inv.wordpressVersion) : null;
  findings.push({
    key: "wordpress:core",
    ruleId: null,
    product: "wordpress",
    productName: "WordPress",
    installed: inv.wordpressVersion,
    state: wp ? "ok" : "unknown",
    flaw: null,
    impact: null,
    cves: [],
    fixedVersion: null,
    howToFix: null,
    summary: wp
      ? `No actively exploited flaw on Forcefield's list affects WordPress ${inv.wordpressVersion} itself.`
      : `Could not check WordPress. ${UNKNOWN_TEXT[inv.wordpressVersion ? "unreadable_version" : "no_version"]}`,
    reason: wp ? null : inv.wordpressVersion ? "unreadable_version" : "no_version",
  });

  const pluginRules = rules.filter((r) => r.product === "wordpress_plugin");
  let otherPlugins = 0;
  for (const p of inv.plugins) {
    const rule = pluginRules.find((r) => r.slug === p.slug);
    if (!rule) { otherPlugins++; continue; }
    findings.push(findingFromRule(rule, p.version, "wordpress_plugin"));
  }

  const status: ExposureState = findings.some((f) => f.state === "exposed")
    ? "exposed"
    : findings.some((f) => f.state === "unknown") ? "unknown" : "ok";
  return { status, findings, otherPlugins, serverSoftware: inv.serverSoftware, kevCatalogDate: kevSnapshotDate() };
}

/** The keys of the exposed findings (what an alert is deduped on). */
export function exposureKeys(report: ServerExposureReport): string[] {
  return report.findings.filter((f) => f.state === "exposed").map((f) => f.key).sort();
}

/** The PHP release line ("8.3") for analytics, or "unknown". Never the full string. */
export function phpLine(inv: Pick<ServerInventory, "phpVersion">): string {
  const v = parseVersion(inv.phpVersion);
  return v ? lineOf(v) : "unknown";
}
