/**
 * Tool-agnostic SARIF ingest for the platform-scan findings pipeline.
 *
 * SARIF (Static Analysis Results Interchange Format, OASIS 2.1.0) is the common
 * output of every mainstream SAST tool: Semgrep, gitleaks, CodeQL, Trivy. Rather
 * than write one parser per tool, we parse the standard once and emit the SAME
 * ScanFinding the HTTP probe + browser runner already emit, so external scanner
 * output flows into the identical store (dedup by (workspace, platform, route,
 * title), auto-resolve on re-scan via scannedRoutes, Brain ingest, analytics).
 * No new persistence path: recordScan owns the learning tie-in.
 *
 * Parsing is fully defensive: SARIF in the wild is shape-loose (vendors differ
 * in where they put rules, severities, tags). Every access is guarded; an
 * unexpected shape skips the affected piece and never throws, so a CI post of a
 * weird SARIF degrades to fewer findings instead of losing the whole run.
 */

import type {
  PlatformScanResult,
  ScanFinding,
  ScanSeverity,
  ScanCategory,
} from "./types";

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Tokens (lowercased) that mark a finding as security rather than a generic bug. */
const SECURITY_TOKENS = [
  "security",
  "owasp",
  "cwe",
  "injection",
  "secret",
  "xss",
  "ssrf",
  "csrf",
  "auth",
];

function looksSecurity(...haystacks: string[]): boolean {
  const blob = haystacks.join(" ").toLowerCase();
  return SECURITY_TOKENS.some((t) => blob.includes(t));
}

/** Map a CVSS-style numeric security-severity (0-10) to our band. */
function severityFromScore(score: number): ScanSeverity {
  if (score >= 9) return "critical";
  if (score >= 7) return "high";
  if (score >= 4) return "medium";
  return "low";
}

/** Map the SARIF `level` enum to our band (used when no numeric score present). */
function severityFromLevel(level: string): ScanSeverity {
  switch (level.toLowerCase()) {
    case "error":
      return "high";
    case "warning":
      return "medium";
    case "note":
    case "none":
      return "low";
    default:
      return "low";
  }
}

/** First physicalLocation artifact uri for a result, or "(unknown)". */
function firstResultUri(result: Obj): string {
  const locations = asArray(result.locations);
  for (const loc of locations) {
    if (!isObj(loc)) continue;
    const phys = loc.physicalLocation;
    if (!isObj(phys)) continue;
    const art = phys.artifactLocation;
    if (!isObj(art)) continue;
    const uri = asString(art.uri);
    if (uri) return uri;
  }
  return "(unknown)";
}

/** region (startLine + snippet text) of the first location, defensively. */
function firstRegion(result: Obj): { line: number; snippet: string } {
  const locations = asArray(result.locations);
  for (const loc of locations) {
    if (!isObj(loc)) continue;
    const phys = loc.physicalLocation;
    if (!isObj(phys)) continue;
    const region = phys.region;
    if (!isObj(region)) continue;
    const line = typeof region.startLine === "number" ? region.startLine : 0;
    let snippet = "";
    if (isObj(region.snippet)) {
      snippet = asString(region.snippet.text).trim();
    }
    return { line, snippet };
  }
  return { line: 0, snippet: "" };
}

/** Index the run's rule definitions by id so a result's ruleId can resolve to a
 *  rule name + tags. Vendors put rules under tool.driver.rules[]. Best effort. */
function buildRuleIndex(run: Obj): Map<string, { name: string; tags: string[] }> {
  const index = new Map<string, { name: string; tags: string[] }>();
  const tool = run.tool;
  if (!isObj(tool)) return index;
  const driver = tool.driver;
  if (!isObj(driver)) return index;
  for (const rule of asArray(driver.rules)) {
    if (!isObj(rule)) continue;
    const id = asString(rule.id);
    if (!id) continue;
    const name = asString(rule.name) || asString(rule.id);
    const tags: string[] = [];
    if (isObj(rule.properties)) {
      for (const t of asArray(rule.properties.tags)) {
        if (typeof t === "string") tags.push(t);
      }
    }
    index.set(id, { name, tags });
  }
  return index;
}

function toolName(run: Obj): string {
  const tool = run.tool;
  if (isObj(tool) && isObj(tool.driver)) {
    const name = asString(tool.driver.name);
    if (name) return name;
  }
  return "sast";
}

/** Collect every artifact uri a run declared (run.artifacts[].location.uri), so
 *  re-scanned-but-now-clean files still count as covered for auto-resolve. */
function runArtifactUris(run: Obj): string[] {
  const uris: string[] = [];
  for (const art of asArray(run.artifacts)) {
    if (!isObj(art)) continue;
    const loc = art.location;
    if (!isObj(loc)) continue;
    const uri = asString(loc.uri);
    if (uri) uris.push(uri);
  }
  return uris;
}

/**
 * Parse a SARIF 2.1.0 document into a PlatformScanResult.
 * `platform` is the logical target name (e.g. "wolfpack-auto"); the tool name is
 * derived from the SARIF itself and used for baseUrl (`sarif:<tool>`).
 */
export function parseSarif(sarif: unknown, platform: string): PlatformScanResult {
  const findings: ScanFinding[] = [];
  const coveredUris = new Set<string>();
  const filesWithFindings = new Set<string>();
  let resolvedToolName = "sast";

  const runs = isObj(sarif) ? asArray(sarif.runs) : [];

  for (const runUnknown of runs) {
    if (!isObj(runUnknown)) continue;
    const run = runUnknown;
    const tool = toolName(run);
    if (tool !== "sast") resolvedToolName = tool;
    const ruleIndex = buildRuleIndex(run);

    // Every declared artifact is a file the scanner looked at -> covered.
    for (const uri of runArtifactUris(run)) coveredUris.add(uri);

    for (const resultUnknown of asArray(run.results)) {
      if (!isObj(resultUnknown)) continue;
      const result = resultUnknown;

      const route = firstResultUri(result);
      if (route !== "(unknown)") coveredUris.add(route);

      const { line, snippet } = firstRegion(result);
      const ruleId = asString(result.ruleId);
      const rule = ruleId ? ruleIndex.get(ruleId) : undefined;

      // Severity: numeric security-severity wins (CVSS 0-10), else SARIF level.
      let severity: ScanSeverity = "low";
      const props = isObj(result.properties) ? result.properties : undefined;
      const rawScore = props ? props["security-severity"] : undefined;
      const score =
        typeof rawScore === "number"
          ? rawScore
          : typeof rawScore === "string" && rawScore.trim() !== ""
            ? Number(rawScore)
            : NaN;
      if (Number.isFinite(score)) {
        severity = severityFromScore(score);
      } else {
        const level = asString(result.level);
        severity = level ? severityFromLevel(level) : "low";
      }

      // Category: security if any of tags / ruleId / rule name carry a token.
      const resultTags: string[] = [];
      if (props) {
        for (const t of asArray(props.tags)) {
          if (typeof t === "string") resultTags.push(t);
        }
      }
      const ruleTags = rule?.tags ?? [];
      const ruleName = rule?.name ?? "";
      const category: ScanCategory = looksSecurity(
        resultTags.join(" "),
        ruleTags.join(" "),
        ruleId,
        ruleName,
      )
        ? "security"
        : "bug";

      const title = ruleName || ruleId || "SAST finding";

      let detail = "";
      if (isObj(result.message)) detail = asString(result.message.text);
      if (ruleId) detail = `${detail} (rule: ${ruleId})`;

      findings.push({
        route,
        severity,
        category,
        title,
        detail,
        // evidence values are scalar-only (string | number | boolean | null).
        evidence: {
          line,
          ruleId,
          tool,
          snippet,
        },
      });
      if (route !== "(unknown)") filesWithFindings.add(route);
    }
  }

  const scannedRoutes = Array.from(coveredUris);

  return {
    platform,
    baseUrl: `sarif:${resolvedToolName}`,
    routeCount: scannedRoutes.length,
    okCount: Math.max(0, scannedRoutes.length - filesWithFindings.size),
    findings,
    scannedRoutes,
  };
}
