/**
 * Forcefield for the Web - BOUNDED request-body inspection.
 *
 * The rest of the engine (enforce.ts / observe.ts) sees only the request target
 * and header NAMES, never bodies. Two actively-exploited RCEs live in the body:
 *
 *   - PHP2Shell (CVE-2026-109618 / CVE-2026-109619): PHP's own multipart /
 *     urlencoded parser corrupts memory / reuses stale request state DURING
 *     request start-up, before any application code runs. A reverse proxy in
 *     FRONT of the PHP worker is the only place that can turn the request away
 *     before the vulnerable parser sees it (Datadog Security Labs,
 *     https://securitylabs.datadoghq.com/articles/php2shell-critical-vulnerabilities-in-php/).
 *   - React2Shell (CVE-2025-55182): a crafted React Server Components "Flight"
 *     deserialization payload in a POST body reaches the Function constructor
 *     via the prototype chain. The reliable, never-legitimate marker is in the
 *     body, not the headers (React/Vercel advisory
 *     https://react.dev/blog/2025/12/03/critical-security-vulnerability-in-react-server-components;
 *     Elastic detection rule for CVE-2025-55182).
 *
 * This module is the ONE body analyzer. It is PURE: an adapter that CAN see the
 * body (the Cloudflare Worker, which proxies to the origin) does the bounded,
 * constant-memory reading and hands the decoded prefix here; this returns the
 * attack label or null. No I/O, no backtracking regex on the input, edge-safe,
 * part of the vendored portable core.
 *
 * BOUNDED BY CONSTRUCTION. The adapter reads at most BODY_SCAN_CAP_BYTES and
 * stops; a trickled or chunked body is never buffered past the cap. Everything
 * here keys off markers that no legitimate form, upload or Server Action request
 * carries, so a match is high-confidence hostile and safe to turn away.
 *
 * WHAT IT CANNOT CATCH (honest, by design):
 *   - Markers that sit PAST the cap: a body padded with >256 KB of junk before
 *     the real payload (the react2shell scanner's --waf-bypass prepends 128 KB
 *     by default, which still lands inside the cap; a larger pad evades).
 *   - Variants the inspecting runtime truncates, or chunked transfer the engine
 *     reassembles differently from the origin's PHP parser. Datadog is explicit
 *     that a proxy cannot fully fix PHP2Shell; patching is the only complete fix.
 *   - Anything an adapter that runs AFTER the PHP parser would see too late: the
 *     WordPress plugin hooks `init`, which fires after PHP has already parsed the
 *     multipart body (the exact code PHP2Shell abuses), so it cannot defend
 *     against PHP2Shell at all - those sites must front PHP with the Worker.
 */

/** Hard cap on bytes the adapter reads for inspection. 256 KiB holds well over a
 *  thousand multipart part-headers - more than enough to count parts and measure
 *  nesting on a machine-generated payload (the public PoC packs ~900 parts into
 *  under 1 MB) - while keeping adapter memory constant and never buffering a
 *  trickled multi-MB body. */
export const BODY_SCAN_CAP_BYTES = 262_144;

export interface BodyInspectInput {
  /** Request method (only POST/PUT/PATCH carry an inspectable attack body). */
  method: string;
  /** Raw Content-Type header value (used for the multipart boundary + the gate). */
  contentType: string;
  /** Declared Content-Length, when present (a trickle check only; never trusted
   *  for sizing the read). Optional. */
  declaredLength?: number;
  /** The decoded body PREFIX the adapter read, latin1/binary-safe so raw null and
   *  control bytes survive and ASCII markers still match. At most BODY_SCAN_CAP_BYTES. */
  body: string;
  /** True when the real body was longer than the prefix (hit the cap). */
  truncated: boolean;
}

export interface BodyAttack {
  /** The payload family, stamped as props.attack and mapped to a KEV CVE. */
  attack: "php2shell" | "react2shell";
  /** Audit-trail reason (no raw body bytes, only the structural finding). */
  reason: string;
}

// ── PHP2Shell thresholds, each justified from the public evidence ─────────────
//
// A legitimate HTML form posts at most a few dozen parts; a file-upload form is
// one file plus a handful of fields. The PoCs are orders of magnitude past that.
/** Part count that is hostile on its own: ~900 parts/<1 MB in the PoC; no real
 *  form sends this many. Unconditional. */
const PART_COUNT_ABNORMAL = 256;
/** Part count that is hostile WHEN the session-upload-progress field is also
 *  present: that field can appear in legitimate traffic (Datadog), so it only
 *  counts combined with a part count far above a normal upload form. */
const PART_COUNT_WITH_MARKER = 32;
/** Field-name bracket nesting that is machine-generated. The PoC field
 *  `files[R00001][a][a][a]` is depth 4; legitimate nested fields
 *  (`address[billing][street]`) rarely exceed depth 3. >=8 is hostile on its
 *  own; >=6 is hostile combined with the upload-progress marker. */
const NESTING_ABNORMAL = 8;
const NESTING_WITH_MARKER = 6;
/** A single urlencoded field NAME this large, with no `=`/`&` to end it, is the
 *  oversized-field-name path (Datadog: a 3-60 MB field name with null/control
 *  bytes). A real urlencoded body is `key=value&key=value`, so `=`/`&` appear
 *  within the first bytes. */
const URLENC_FIELD_MIN = 65_536;

const UPLOAD_PROGRESS_FIELD = "php_session_upload_progress";

function contentTypeIs(ct: string, kind: string): boolean {
  return ct.toLowerCase().trimStart().startsWith(kind);
}

/** The multipart boundary from a Content-Type, or null. Bounded string parse. */
function multipartBoundary(ct: string): string | null {
  const m = /boundary=("?)([^";,\s]+)\1/i.exec(ct);
  return m ? m[2] : null;
}

/** Max bracket-nesting depth in a multipart field name: the number of `[` it
 *  contains (`files[a][b][c]` -> 3). Linear scan, no backtracking. */
function bracketDepth(name: string): number {
  let d = 0;
  for (let i = 0; i < name.length; i++) if (name.charCodeAt(i) === 0x5b /* [ */) d++;
  return d;
}

/** A raw null byte or a C0 control char other than tab/CR/LF - never present in
 *  a legitimate urlencoded field name. */
function hasBinaryControl(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0 || (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d)) return true;
  }
  return false;
}

/** The React2Shell Flight reference: `$<digits>:<name>:<name>`. Linear regex. */
const FLIGHT_REF = /\$[0-9]+:[A-Za-z0-9_]+:[A-Za-z0-9_]+/;

/**
 * React2Shell (CVE-2025-55182). The never-legitimate combination the Elastic
 * detection rule keys on: an RSC Flight reference together with a prototype-chain
 * traversal token. A real Server Action body carries Flight references but never
 * pairs them with `__proto__` / `constructor:constructor` / `prototype`, so the
 * pair is the high-confidence marker (not the Next-Action header, which every
 * legitimate action sends - keying on that alone would block real traffic).
 */
function detectReact2Shell(body: string): BodyAttack | null {
  if (!FLIGHT_REF.test(body)) return null;
  const lower = body.toLowerCase();
  if (lower.includes("__proto__") || lower.includes("constructor:constructor") || lower.includes('"prototype"') || lower.includes("prototype:")) {
    return { attack: "react2shell", reason: "RSC Flight prototype-pollution marker in request body (CVE-2025-55182)" };
  }
  return null;
}

/** Walk a multipart body's part headers within the scanned prefix. Bounded: it
 *  stops at the end of the prefix, so a truncated body yields the counts seen so
 *  far (which only ever UNDER-counts, never a false positive). */
function scanMultipart(body: string, boundary: string): BodyAttack | null {
  const delim = `--${boundary}`;
  let partCount = 0;
  let hasUploadProgress = false;
  let maxDepth = 0;
  let idx = body.indexOf(delim);
  while (idx !== -1) {
    const headerStart = idx + delim.length;
    // Part headers end at the first blank line; stay within the prefix.
    const headerEnd = body.indexOf("\r\n\r\n", headerStart);
    const slice = headerEnd === -1 ? body.slice(headerStart, headerStart + 1024) : body.slice(headerStart, headerEnd);
    const cd = /content-disposition:[^\r\n]*/i.exec(slice);
    if (cd) {
      partCount++;
      const nameM = /name="([^"]*)"/i.exec(cd[0]);
      const name = nameM ? nameM[1] : "";
      if (name.toLowerCase().includes(UPLOAD_PROGRESS_FIELD)) hasUploadProgress = true;
      const depth = bracketDepth(name);
      if (depth > maxDepth) maxDepth = depth;
      const fileM = /filename="([^"]*)"/i.exec(cd[0]);
      if (fileM) {
        const fn = fileM[1].toLowerCase();
        // An upload filename carrying a PHP open tag or a serialized-object
        // fragment is a webshell / object-injection drop: never a real filename.
        if (fn.includes("<?php") || fn.includes("<?=") || fn.includes("|o:")) {
          return { attack: "php2shell", reason: "PHP tag / serialized-object marker in an upload filename (CVE-2026-109618/109619)" };
        }
      }
    }
    idx = body.indexOf(delim, headerStart);
  }
  if (partCount >= PART_COUNT_ABNORMAL) {
    return { attack: "php2shell", reason: `abnormal multipart part count (${partCount}) far beyond any real form (CVE-2026-109618)` };
  }
  if (maxDepth >= NESTING_ABNORMAL) {
    return { attack: "php2shell", reason: `machine-generated field-name nesting depth (${maxDepth}) (CVE-2026-109618)` };
  }
  if (hasUploadProgress && (partCount >= PART_COUNT_WITH_MARKER || maxDepth >= NESTING_WITH_MARKER)) {
    return { attack: "php2shell", reason: `PHP_SESSION_UPLOAD_PROGRESS field with abnormal structure (parts=${partCount}, depth=${maxDepth}) (CVE-2026-109619)` };
  }
  return null;
}

/** A single oversized urlencoded field NAME with embedded control bytes. */
function scanUrlencoded(input: BodyInspectInput): BodyAttack | null {
  const body = input.body;
  // A legitimate urlencoded body ends the first key within a few bytes with `=`
  // or `&`. The attack is one giant key: no `=`/`&` anywhere in the prefix.
  if (body.includes("=") || body.includes("&")) return null;
  const bigEnough = input.truncated || body.length >= URLENC_FIELD_MIN;
  if (bigEnough && hasBinaryControl(body)) {
    return { attack: "php2shell", reason: `single oversized urlencoded field name with control bytes (CVE-2026-109618)` };
  }
  return null;
}

/**
 * Inspect one bounded request-body prefix. Returns the attack label or null.
 * Pure, never throws (any surprise returns null -> the request proceeds).
 */
export function inspectRequestBody(input: BodyInspectInput): BodyAttack | null {
  try {
    const method = (input.method ?? "").toUpperCase();
    if (method !== "POST" && method !== "PUT" && method !== "PATCH") return null;
    if (!input.body) return null;
    const ct = input.contentType ?? "";

    // React2Shell: the Flight marker can ride in multipart, urlencoded or plain
    // bodies, so check it on the raw prefix regardless of content-type first.
    const r2s = detectReact2Shell(input.body);
    if (r2s) return r2s;

    if (contentTypeIs(ct, "multipart/form-data")) {
      const boundary = multipartBoundary(ct);
      if (boundary) return scanMultipart(input.body, boundary);
      return null;
    }
    if (contentTypeIs(ct, "application/x-www-form-urlencoded")) {
      return scanUrlencoded(input);
    }
    return null;
  } catch {
    return null;
  }
}

/** Does this request's method + content-type warrant reading the body at all?
 *  Keeps the adapter from touching bodies it has no rule for. A `next-action`
 *  header also qualifies a POST (React2Shell drives the Server Action endpoint). */
export function bodyInspectionApplies(method: string, contentType: string, hasNextAction: boolean): boolean {
  const m = (method ?? "").toUpperCase();
  if (m !== "POST" && m !== "PUT" && m !== "PATCH") return false;
  const ct = (contentType ?? "").toLowerCase();
  return (
    ct.startsWith("multipart/form-data") ||
    ct.startsWith("application/x-www-form-urlencoded") ||
    ct.startsWith("text/plain") ||
    hasNextAction
  );
}
