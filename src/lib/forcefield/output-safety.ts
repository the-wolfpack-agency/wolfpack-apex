/**
 * Model-output safety scan - the live lens for OWASP LLM02 (insecure output
 * handling). A model can be talked into emitting active/executable content
 * (a <script>, an event handler, a javascript: URI); if a downstream sink renders
 * that as HTML without escaping, the model's answer becomes an XSS vector. This
 * scans the model's FREE-TEXT output for that content before it leaves our
 * boundary.
 *
 * Precision-first (mirrors the platform-scan / ai-code detector philosophy):
 *   - Fenced and inline code are stripped first, so a legitimate code EXAMPLE of
 *     `<script>` in a ``` block is never flagged - only active content in the
 *     RENDERED prose is insecure output handling.
 *   - Each pattern matches a real, dangerous-if-rendered construct, not a broad
 *     "contains an angle bracket" heuristic.
 *
 * Pure + deterministic + I/O-free (unit-testable, safe to call on any hot path).
 * Callers use it OBSERVE-ONLY: flag/record, never mutate or block the answer.
 */
export type OutputRiskKind =
  | "script_tag"
  | "iframe_embed"
  | "js_uri"
  | "event_handler"
  | "data_html";

export interface OutputRisk {
  kind: OutputRiskKind;
  /** A short excerpt of what matched (for the audit trail; never the full text). */
  match: string;
}

/** Remove fenced ``` blocks and inline `code` so a code sample is not mistaken
 *  for active content. What remains is the prose a UI would render. */
function stripCode(text: string): string {
  return text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`]*`/g, " ");
}

const PATTERNS: ReadonlyArray<{ kind: OutputRiskKind; re: RegExp }> = [
  { kind: "script_tag", re: /<\s*script\b/i },
  { kind: "iframe_embed", re: /<\s*(?:iframe|object|embed)\b/i },
  { kind: "js_uri", re: /\bjavascript:\s*[^\s"')]/i },
  { kind: "event_handler", re: /<[^>]+\son[a-z]+\s*=/i },
  { kind: "data_html", re: /\bdata:text\/html/i },
];

/** Scan model free-text output for active/executable content (LLM02). Returns one
 *  risk per distinct construct found; empty for safe output. */
export function scanModelOutput(text: string): OutputRisk[] {
  if (!text) return [];
  const body = stripCode(text);
  const out: OutputRisk[] = [];
  for (const p of PATTERNS) {
    const m = body.match(p.re);
    if (m) out.push({ kind: p.kind, match: m[0].slice(0, 40) });
  }
  return out;
}
