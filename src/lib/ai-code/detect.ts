/**
 * AI-code detectors + unified-diff parser. Precision-first (mirrors the
 * platform-scan / ai-surface detector philosophy): each rule matches a real,
 * reviewable risk signature, never a generic keyword, so the gate's verdict can
 * be trusted. Detectors run over the ADDED lines only - we govern what the AI
 * introduced, not the whole file.
 */
import { KEY_SIGNATURES } from "@/lib/ai-surface/detect";
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
    test: (t) =>
      /\beval\s*\(/.test(t) ||
      /new\s+Function\s*\(/.test(t) ||
      /\bexec(?:Sync)?\s*\(|\bexecFile(?:Sync)?\s*\(|child_process/.test(t),
  },
  {
    klass: "disabled_tls",
    severity: "high",
    cwe: "CWE-295",
    title: "TLS verification disabled",
    detail: "AI-authored code disables certificate validation (MITM exposure).",
    test: (t) => /rejectUnauthorized\s*:\s*false/.test(t) || /NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0/.test(t),
  },
  {
    klass: "dangerous_html",
    severity: "medium",
    cwe: "CWE-79",
    title: "Unsanitized HTML injection sink",
    detail: "AI-authored code adds dangerouslySetInnerHTML or innerHTML assignment (XSS risk).",
    test: (t) => /dangerouslySetInnerHTML/.test(t) || /\.innerHTML\s*=/.test(t),
  },
  {
    klass: "sql_concat",
    severity: "high",
    cwe: "CWE-89",
    title: "SQL built by string interpolation",
    detail: "AI-authored code builds a SQL statement with interpolation/concatenation (injection risk). Parameterize it.",
    test: (t) =>
      /\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|FROM|WHERE)\b/i.test(t) && (/\$\{/.test(t) || /['"]\s*\+|\+\s*['"]/.test(t)),
  },
  {
    klass: "weak_random",
    severity: "medium",
    cwe: "CWE-338",
    title: "Weak randomness in a security context",
    detail: "AI-authored code uses Math.random() near a token/secret/nonce. Use a CSPRNG.",
    test: (t) => /Math\.random\s*\(\)/.test(t) && /\b(token|secret|password|nonce|salt|otp|key|session)\b/i.test(t),
  },
  {
    klass: "open_cors",
    severity: "medium",
    cwe: "CWE-942",
    title: "Permissive CORS introduced",
    detail: "AI-authored code allows any origin (Access-Control-Allow-Origin: * or cors origin true).",
    test: (t) =>
      /access-control-allow-origin['"]?\s*[:,]\s*['"]\*/i.test(t) || /\borigin\s*:\s*(?:true|['"]\*['"])/.test(t),
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
  }
  return out;
}

/** Convenience: parse a unified diff and detect in one call. */
export function reviewDiff(diff: string): AiCodeFinding[] {
  return detectCodeFindings(parseAddedLines(diff));
}
