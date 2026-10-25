/**
 * Pure rules for the public-artifact credential scan.
 *
 * WHY THIS EXISTS. On 2026-10-20 a live-site E2E run in this PUBLIC repository
 * uploaded its Playwright trace. A trace records every request with its
 * cookies, so the artifact carried a CTO-role instinct_access_token and a
 * 7-day instinct_refresh_token that any signed-in GitHub user could download.
 * The workflow guardrail (src/__tests__/no-public-test-artifacts.test.ts) stops
 * the known upload shapes; this scan looks at what was actually published.
 *
 * NEVER RECORD THE MATCH. A scanner that copies a leaked credential into its
 * report has leaked it a second time, into a file people pass around. Every
 * function here returns the pattern NAME and where it was seen; the matched
 * text is tested and dropped inside `scanText` and never leaves it.
 */
import type { Finding, Severity } from "./report";

export interface CredentialPattern {
  /** Stable name, recorded in findings in place of the value. */
  name: string;
  severity: Severity;
  /** What the shape is, for the report reader. */
  label: string;
  re: RegExp;
  /** Second look at a match, for shapes a regex alone cannot settle. */
  accept?: (match: string) => boolean;
}

/** Passwords that appear in docs, examples and CI service containers. */
const PLACEHOLDER_PASSWORDS = new Set(["password", "pass", "passwd", "postgres", "secret", "changeme", "example", "test", "user", "xxx", "pw"]);
const LOCAL_HOSTS = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0|postgres|db)(:\d+)?$/i;

function postgresUrlIsReal(m: string): boolean {
  const at = /^postgres(?:ql)?:\/\/([^:]+):([^@]+)@([^/?#\s'"]+)/i.exec(m);
  if (!at) return false;
  const password = at[2];
  const host = at[3];
  if (PLACEHOLDER_PASSWORDS.has(password.toLowerCase())) return false;
  if (/^[$<{*%]/.test(password) || /^\*+$/.test(password)) return false; // ${VAR}, <password>, ***
  if (LOCAL_HOSTS.test(host)) return false; // CI service container, not a reachable credential
  return true;
}

/** A real API key tail mixes cases and digits; a CSS class or slug does not. */
function looksRandom(m: string): boolean {
  const tail = m.replace(/^sk-(?:proj-|ant-api\d\d-|svcacct-|admin-)?/, "");
  return /[0-9]/.test(tail) && /[a-z]/.test(tail) && /[A-Z]/.test(tail);
}

/** A JWT's payload segment decodes to a JSON object; a fixture string or a lookalike does not. */
function jwtPayloadDecodes(m: string): boolean {
  const payload = m.split(".")[1] ?? "";
  try {
    const v = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    return typeof v === "object" && v !== null && !Array.isArray(v);
  } catch {
    return false;
  }
}

export const CREDENTIAL_PATTERNS: CredentialPattern[] = [
  {
    name: "instinct-session-cookie",
    severity: "critical",
    label: "instinct_access_token or instinct_refresh_token cookie with a value",
    re: /instinct_(?:access|refresh)_token=[^;\s"'&,\\]{8,}/g,
  },
  {
    name: "instinct-session-cookie-json",
    severity: "critical",
    label: "instinct session cookie in a storage-state or trace record",
    re: /"name"\s*:\s*"instinct_(?:access|refresh)_token"\s*,\s*"value"\s*:\s*"[^"]{8,}"/g,
  },
  {
    name: "authorization-bearer",
    severity: "critical",
    label: "Authorization: Bearer header with a token",
    re: /authorization["']?\s*[:=]\s*["']?bearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  },
  {
    name: "authorization-bearer-json",
    severity: "critical",
    label: "Authorization: Bearer header in a recorded request",
    re: /"name"\s*:\s*"authorization"\s*,\s*"value"\s*:\s*"bearer\s+[^"]{16,}"/gi,
  },
  {
    name: "postgres-url-with-password",
    severity: "critical",
    label: "Postgres connection URL containing a password",
    re: /postgres(?:ql)?:\/\/[^\s:@/'"]+:[^\s@/'"]+@[^\s/'"?#]+/gi,
    accept: postgresUrlIsReal,
  },
  {
    name: "jwt",
    severity: "high",
    label: "JSON Web Token",
    re: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g,
    accept: jwtPayloadDecodes,
  },
  { name: "github-pat-classic", severity: "high", label: "GitHub personal access token (ghp_)", re: /\bghp_[A-Za-z0-9]{36}\b/g },
  { name: "github-pat-fine-grained", severity: "high", label: "GitHub fine-grained token (github_pat_)", re: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/g },
  {
    name: "sk-api-key",
    severity: "high",
    label: "sk- API key (OpenAI, Anthropic and similar)",
    re: /\bsk-(?:proj-|ant-api\d\d-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g,
    accept: looksRandom,
  },
  {
    name: "aws-access-key-id",
    severity: "high",
    label: "AWS access key id",
    re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    // AWS's documentation key (AKIAIOSFODNN7EXAMPLE) is in many test fixtures.
    accept: (m) => !m.endsWith("EXAMPLE"),
  },
  {
    name: "slack-webhook",
    severity: "high",
    label: "Slack incoming webhook URL",
    re: /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]{6,}\/B[A-Z0-9]{6,}\/[A-Za-z0-9]{16,}/g,
  },
];

export interface PatternHit {
  pattern: string;
  severity: Severity;
  /** How many times this pattern matched in the text. */
  count: number;
}

/**
 * Which credential shapes appear in `text`. Returns names and counts only.
 *
 * A session cookie is usually also a JWT; both are reported, because "the
 * trace holds 3 cookies and 12 bearer JWTs" is what the responder needs.
 */
export function scanText(text: string, patterns: CredentialPattern[] = CREDENTIAL_PATTERNS): PatternHit[] {
  const out: PatternHit[] = [];
  for (const p of patterns) {
    let count = 0;
    const re = new RegExp(p.re.source, p.re.flags.includes("g") ? p.re.flags : p.re.flags + "g");
    for (const m of text.matchAll(re)) {
      if (!p.accept || p.accept(m[0])) count += 1;
    }
    if (count > 0) out.push({ pattern: p.name, severity: p.severity, count });
  }
  return out;
}

export interface ArtifactRef {
  repo: string; // owner/name
  id: number;
  name: string;
  createdAt: string;
  sizeBytes: number;
  runId: number | null;
}

export function runUrl(a: ArtifactRef): string {
  return a.runId ? `https://github.com/${a.repo}/actions/runs/${a.runId}` : `https://github.com/${a.repo}/actions`;
}

export function deleteCommand(a: ArtifactRef): string {
  return `gh api -X DELETE repos/${a.repo}/actions/artifacts/${a.id}`;
}

/** One finding per (artifact, file, pattern). Location and name only. */
export function hitFinding(a: ArtifactRef, filePath: string, hit: PatternHit): Finding {
  const label = CREDENTIAL_PATTERNS.find((p) => p.name === hit.pattern)?.label ?? hit.pattern;
  return {
    severity: hit.severity,
    rule: `artifact.${hit.pattern}`,
    subject: `${a.repo} artifact "${a.name}" (id ${a.id}, created ${a.createdAt})`,
    detail:
      `${filePath}: ${hit.count} match(es) of ${label}. This artifact is downloadable by anyone signed in to GitHub. ` +
      `Delete it (\`${deleteCommand(a)}\` or the trash icon on the run page), then revoke what it holds` +
      (hit.pattern.startsWith("instinct-session") ? " with `npm run security:revoke-session` (docs/security/incident-runbook.md)." : "."),
    source: runUrl(a),
  };
}

export function oversizeFinding(a: ArtifactRef, capBytes: number): Finding {
  return {
    severity: "low",
    rule: "artifact.not-scanned-too-large",
    subject: `${a.repo} artifact "${a.name}" (id ${a.id}, created ${a.createdAt})`,
    detail: `${(a.sizeBytes / 1048576).toFixed(1)} MB is over the ${(capBytes / 1048576).toFixed(0)} MB scan cap, so it was NOT scanned. Raise --max-mb or inspect it by hand.`,
    source: runUrl(a),
  };
}

/** Download or unzip failed: an artifact we could not read may still hold a leak. */
export function notScannedFinding(a: ArtifactRef, reason: string): Finding {
  return {
    severity: "medium",
    rule: "artifact.not-scanned-error",
    subject: `${a.repo} artifact "${a.name}" (id ${a.id}, created ${a.createdAt})`,
    detail: `Could not scan: ${reason}. Re-run, or download it and inspect it by hand.`,
    source: runUrl(a),
  };
}

/** Is this file a zip (Playwright nests trace.zip inside the artifact zip)? */
export function isZipHeader(head: Uint8Array): boolean {
  return head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
}

/** Sum of the "Length" column of `unzip -l`, to refuse a zip bomb before extracting. */
export function unzipListedBytes(listing: string): number {
  const lines = listing.trim().split("\n");
  const last = lines[lines.length - 1] ?? "";
  const m = /^\s*(\d+)\s+\d+\s+files?\s*$/.exec(last);
  return m ? Number(m[1]) : Number.POSITIVE_INFINITY;
}

export interface ArtifactApiRow {
  id: number;
  name: string;
  size_in_bytes: number;
  expired: boolean;
  created_at: string;
  workflow_run?: { id?: number | null } | null;
}

export function toArtifactRefs(repo: string, rows: ArtifactApiRow[]): ArtifactRef[] {
  return rows
    .filter((r) => !r.expired)
    .map((r) => ({ repo, id: r.id, name: r.name, createdAt: r.created_at, sizeBytes: r.size_in_bytes, runId: r.workflow_run?.id ?? null }));
}

/** GitHub answers a primary or secondary rate limit with 403 or 429 and says so in the message. */
export function isRateLimited(status: number | null, message: string): boolean {
  return status === 429 || (status === 403 && /rate limit/i.test(message));
}

/** One finding for everything a rate limit left unscanned, rather than one per artifact. */
export function rateLimitFinding(unscanned: ArtifactRef[]): Finding {
  const repos = [...new Set(unscanned.map((a) => a.repo))].sort();
  return {
    severity: "medium",
    rule: "artifact.scan-incomplete-rate-limited",
    subject: repos.join(", "),
    detail: `GitHub rate-limited the downloads, so ${unscanned.length} artifact(s) were NOT scanned. Re-run after the limit resets (gh api rate_limit), or narrow with --repo or --days.`,
    source: "https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api",
  };
}

/** --days: keep artifacts created within the last `days` days (null keeps all). */
export function createdWithin(refs: ArtifactRef[], days: number | null, now: Date = new Date()): ArtifactRef[] {
  if (days === null || !Number.isFinite(days)) return refs;
  const floor = now.getTime() - days * 86_400_000;
  return refs.filter((a) => new Date(a.createdAt).getTime() >= floor);
}
