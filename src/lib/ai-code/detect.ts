/**
 * AI-code detectors + unified-diff parser. Precision-first (mirrors the
 * platform-scan / ai-surface detector philosophy): each rule matches a real,
 * reviewable risk signature, never a generic keyword, so the gate's verdict can
 * be trusted. Detectors run over the ADDED lines only - we govern what the AI
 * introduced, not the whole file.
 */
import { KEY_SIGNATURES } from "@/lib/ai-surface/detect";
import { secretInLogs } from "@/lib/platform-scan/static/detectors";
import {
  // ONE definition of each security pattern, shared with the whole-file scanner
  // (platform-scan/static/detectors.ts) via security-corpus - no second copy.
  isCodeExecLine,
  isSqlInjectionLine,
  isWeakRandomLine,
  DANGEROUS_HTML,
  TLS_DISABLED,
  OPEN_CORS,
  OPEN_CORS_OPTION,
} from "@/lib/platform-scan/static/security-corpus";
import type { AddedLine, AiCodeFinding } from "./types";

/**
 * Parse a unified diff into its added lines, tracking the new-file line number
 * from each hunk header. Ignores `+++` file headers; `-` lines do not advance
 * the new-file counter. Files resolved from the `+++ b/<path>` header.
 */
export function parseAddedLines(diff: string): AddedLine[] {
  const out: AddedLine[] = [];
  let file = "";
  let newLine = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ ")) {
      const p = raw.slice(4).trim().replace(/^b\//, "");
      file = p === "/dev/null" ? "" : p;
      continue;
    }
    if (raw.startsWith("--- ")) continue;
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      newLine = parseInt(hunk[1], 10);
      continue;
    }
    if (raw.startsWith("+")) {
      if (file) out.push({ file, line: newLine, text: raw.slice(1) });
      newLine++;
    } else if (raw.startsWith("-")) {
      // removed line: does not exist in the new file, no counter advance
    } else {
      // context (leading space) or other: advances the new-file counter
      newLine++;
    }
  }
  return out;
}

interface Rule {
  klass: string;
  severity: AiCodeFinding["severity"];
  cwe: string | null;
  title: string;
  detail: string;
  /** Returns true when the added line is a violation. */
  test: (text: string) => boolean;
}

const isEnvOrPlaceholder = (t: string) =>
  /process\.env|import\.meta\.env|\$\{|<[^>]+>|\byour[_-]|[_-]here\b|xxxx|example|changeme|placeholder|redacted|dummy|\bfake|\bsample/i.test(t);

// An interactive device-authorization / credential-consent flow introduced into
// committed code. Born from the 2026-10 incident: a backgrounded `until vercel ls`
// loop (unauthenticated) spammed device-authorization BROWSER prompts for days -
// the same shape as a device-code phishing / consent-fatigue attack (approve-this-
// device spam until a tired operator approves one). Committed code must never
// trigger an interactive login; a human runs those out of band, and automation
// authenticates with a scoped, non-interactive token. This mirrors the dev-side
// Claude Code guard (auth-loop-guard.py) so the rule the agent authors under and
// the rule that guards the operator's own shell are one rule.
// Every sub-pattern is a single-quantifier-over-single-class alternation (no
// overlapping quantifiers) -> linear time, no ReDoS.
const INTERACTIVE_LOGIN =
  /\b(?:vercel|netlify|wrangler|supabase|firebase|heroku|railway)\s+login\b|\bgh\s+auth\s+login\b|\b(?:npm|pnpm|yarn)\s+login\b|\bgcloud\s+auth\s+login\b|\baws\s+sso\s+login\b|\baz\s+login\b|\b(?:flyctl|fly)\s+auth\s+login\b|\bdoctl\s+auth\s+init\b/i;
// An auth-prompting CLI as a COMMAND token (not inside a hostname/path like
// "x.vercel.app"): reject a leading . / - or word char, and a trailing one.
const AUTH_CLI = /(?<![./\w-])(?:vercel|netlify|wrangler|supabase|heroku|flyctl)(?![.\w-])/i;
const NONINTERACTIVE_TOKEN = /--token\b|_TOKEN\b|--access-token\b|--auth-token\b/i;
const LOOPS = /\b(?:until|while)\b/;

/** True when an added line triggers an interactive auth / device-authorization flow. */
export function isInteractiveAuthLine(t: string): boolean {
  if (INTERACTIVE_LOGIN.test(t)) return true;
  // an auth-prompting CLI inside a loop, with no non-interactive token -> the
  // exact runaway/consent-fatigue shape.
  if (LOOPS.test(t) && AUTH_CLI.test(t) && !NONINTERACTIVE_TOKEN.test(t)) return true;
  return false;
}

const RULES: Rule[] = [
  {
    klass: "secret",
    severity: "critical",
    cwe: "CWE-798",
    title: "Hardcoded secret introduced",
    detail: "AI-authored code adds a hardcoded credential. Reference a secret store, never inline it.",
    test: (t) =>
      KEY_SIGNATURES.some((s) => s.re.test(t)) ||
      (/(?:password|passwd|secret|api[_-]?key|access[_-]?key|private[_-]?key|auth[_-]?token)\s*[:=]\s*["'][^"']{8,}["']/i.test(t) &&
        !isEnvOrPlaceholder(t)),
  },
  {
    klass: "eval_exec",
    severity: "high",
    cwe: "CWE-95",
    title: "Dynamic code / command execution introduced",
    detail: "AI-authored code adds eval, new Function, or a child_process exec. Confirm input is not attacker-controlled.",
    test: (t) => isCodeExecLine(t),
  },
  {
    klass: "disabled_tls",
    severity: "high",
    cwe: "CWE-295",
    title: "TLS verification disabled",
    detail: "AI-authored code disables certificate validation (MITM exposure).",
    test: (t) => TLS_DISABLED.test(t),
  },
  {
    klass: "dangerous_html",
    severity: "medium",
    cwe: "CWE-79",
    title: "Unsanitized HTML injection sink",
    detail: "AI-authored code adds dangerouslySetInnerHTML or innerHTML assignment (XSS risk).",
    test: (t) => DANGEROUS_HTML.test(t),
  },
  {
    klass: "sql_concat",
    severity: "high",
    cwe: "CWE-89",
    title: "SQL built by string interpolation",
    detail: "AI-authored code builds a SQL statement with interpolation/concatenation (injection risk). Parameterize it.",
    test: (t) => isSqlInjectionLine(t),
  },
  {
    klass: "weak_random",
    severity: "medium",
    cwe: "CWE-338",
    title: "Weak randomness in a security context",
    detail: "AI-authored code uses Math.random() near a token/secret/nonce. Use a CSPRNG.",
    test: (t) => isWeakRandomLine(t),
  },
  {
    klass: "open_cors",
    severity: "medium",
    cwe: "CWE-942",
    title: "Permissive CORS introduced",
    detail: "AI-authored code allows any origin (Access-Control-Allow-Origin: * or cors origin true).",
    test: (t) => OPEN_CORS.test(t) || OPEN_CORS_OPTION.test(t),
  },
  {
    klass: "suppressed_security",
    severity: "medium",
    cwe: null,
    title: "Security check suppressed",
    detail: "AI-authored code suppresses a security linter (nosec / eslint security disable).",
    test: (t) => /\/\/\s*nosec/i.test(t) || /eslint-disable[^\n]*security/i.test(t),
  },
  {
    klass: "exfil_network",
    severity: "high",
    cwe: "CWE-200",
    title: "New external network call (review for exfiltration)",
    detail: "AI-authored code adds a request to a hardcoded external host. Confirm it is not a data-exfiltration / callback channel.",
    test: (t) => {
      const m = t.match(/(?:fetch|axios|got|\.post|\.get|https?\.request)\s*\(\s*['"]https?:\/\/([^'"/\s]+)/i);
      return !!m && !/^(localhost|127\.0\.0\.1|0\.0\.0\.0)/.test(m[1]);
    },
  },

  {
    klass: "interactive_auth",
    severity: "high",
    cwe: "CWE-287",
    title: "Interactive auth / device-authorization flow in committed code",
    detail:
      "AI-authored code triggers an interactive login or loops an auth CLI that opens a device-authorization prompt (a consent-fatigue / device-code phishing vector). Committed code must authenticate non-interactively with a scoped token, never a human-in-the-loop login.",
    test: (t) => isInteractiveAuthLine(t),
  },
];

/** Run every detector over the added lines of a diff. */
export function detectCodeFindings(added: AddedLine[]): AiCodeFinding[] {
  const out: AiCodeFinding[] = [];
  for (const a of added) {
    for (const r of RULES) {
      if (r.test(a.text)) {
        out.push({
          file: a.file,
          line: a.line,
          klass: r.klass,
          severity: r.severity,
          cwe: r.cwe,
          title: r.title,
          detail: r.detail,
          evidence: { snippet: a.text.trim().slice(0, 200) },
        });
      }
    }
    // A credential, token, or single-use link reaching a log. Reuses the ONE
    // log-secret detector (platform-scan) rather than a second copy, so this
    // gate and platform-scan share one implementation. Logging a bearer
    // credential is a leak, so it is critical (blocks the merge); the detector
    // already redacts a provider-signature secret in its snippet.
    for (const s of secretInLogs({ path: a.file, content: a.text })) {
      out.push({
        file: a.file,
        line: a.line,
        klass: s.severity === "critical" ? "logged_secret" : "logged_credential",
        severity: "critical",
        cwe: "CWE-532",
        title: s.title,
        detail: s.detail,
        evidence: { snippet: String(s.evidence.snippet).slice(0, 200) },
      });
    }
  }
  return out;
}

/** Convenience: parse a unified diff and detect in one call. */
export function reviewDiff(diff: string): AiCodeFinding[] {
  return detectCodeFindings(parseAddedLines(diff));
}
