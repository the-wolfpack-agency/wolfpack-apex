/**
 * What an assistant answer must never contain, whoever is connected.
 *
 * WHY THIS EXISTS. The routing audit checks that a phrasing reaches the right
 * tool. It cannot see the answer, so it passed the morning brief on the day
 * that brief read out "Meeting ID: AAMkAG..." and 'cache status is "miss"' into
 * prose a person reads. Routing was fine; the answer leaked.
 *
 * These detectors are the other half: they read the finished answer and flag
 * the failures that are wrong REGARDLESS of what is connected. A Graph id, an
 * unfilled {{slot}}, a raw cache field, an essay where a sentence would do,
 * these are never right whether or not Microsoft is connected, whether the
 * mailbox is full or empty. That makes them a clean guardrail: a harness can
 * run every prompt through the real router and gate and fail on a leak without
 * needing a populated account to compare against.
 *
 * PRECISION over breadth, the rule the scanners follow. A detector that fires
 * on ordinary prose is one somebody switches off. Each pattern below keys on a
 * shape a leak actually takes, and the tests pin the boundary: it must catch
 * "Meeting ID: AAMkAG..." without catching "the meeting id is on the invite".
 */

/** One thing wrong with an answer, and where. */
export interface AnswerFinding {
  kind: "opaque_id" | "cache_field" | "unfilled_slot" | "cursor_token" | "bloat" | "empty";
  /** Severity: a leak is never acceptable; bloat and empty are warnings. */
  severity: "leak" | "warn";
  /** The offending fragment, trimmed, so a person can see what fired. */
  evidence: string;
}

export interface AnswerAudit {
  findings: AnswerFinding[];
  /** True when nothing is a leak. Bloat and empty are reported but do not leak. */
  clean: boolean;
}

/**
 * A Microsoft Graph identifier, the exact thing that leaked.
 *
 * Graph message and event ids are long base64url blobs that begin AAMk or AQMk.
 * Keyed on that prefix plus length so it cannot fire on a short word, and it is
 * the specific shape a person saw in the brief. */
const GRAPH_ID = /\b(?:AAMk|AQMk|AAkAL)[A-Za-z0-9_\-+/=]{16,}/;

/**
 * A generic opaque token: a long high-entropy run a human never types.
 *
 * PRECISION LEARNED THE HARD WAY. The first version was /[A-Za-z0-9+/]{32,}/,
 * and on real data it flagged "mastrosthousandoaks/ConsumerDisclosure", a URL
 * path inside a document the user had asked for. Not a leak, and a detector
 * that cries wolf on legitimate retrieved content is one somebody switches off.
 *
 * Two changes fix it. The slash is gone from the class, so a URL path is not
 * one token. And the run must contain BOTH a letter and a digit, the signature
 * of an id or a base64 blob, which a readable word run like ConsumerDisclosure
 * does not have. That trades a little recall for precision, and the specific
 * case that actually leaked, a Graph id, is caught by GRAPH_ID above regardless. */
const OPAQUE_TOKEN = /\b(?=[A-Za-z0-9+]*\d)(?=[A-Za-z0-9+]*[A-Za-z])[A-Za-z0-9+]{32,}={0,2}\b/;

/** A raw cache field narrated as prose, e.g. cache status is "miss". */
const CACHE_FIELD = /\bcache[\s_-]?(?:status|state|hit|miss)\b|"(?:hit|miss)"\s*(?:from cache)?/i;

/** A pagination cursor or transport token that should never reach a reader. */
const CURSOR_TOKEN = /\b(?:next[\s_-]?(?:link|cursor|page[\s_-]?token)|@odata\.nextLink|etag)\b/i;

/** An unfilled routine slot: the chain substituted nothing and shipped the marker. */
const UNFILLED_SLOT = /\{\{\s*[a-z0-9_.]+\s*\}\}/i;

/** Above this, a brief has become an essay. Set high so only real bloat fires. */
export const BLOAT_CHARS = 1800;

/** Known degraded-fallback shapes that read as an answer but say nothing. */
const EMPTY_SHAPES = [/^\s*$/, /^\s*(?:undefined|null|\[object Object\])\s*$/i];

function fragment(text: string, match: RegExpMatchArray): string {
  const at = match.index ?? 0;
  return text.slice(Math.max(0, at - 12), at + match[0].length + 12).replace(/\s+/g, " ").trim();
}

/**
 * Read a finished answer and report what is wrong with it.
 *
 * Order matters only for readability; every detector runs. A leak makes the
 * answer unclean; bloat and empty are warnings a harness can surface without
 * failing a run on a legitimately terse or legitimately long reply.
 */
export function auditAnswer(text: string): AnswerAudit {
  const findings: AnswerFinding[] = [];
  const leak = (kind: AnswerFinding["kind"], m: RegExpMatchArray | null) => {
    if (m) findings.push({ kind, severity: "leak", evidence: fragment(text, m) });
  };

  leak("opaque_id", text.match(GRAPH_ID));
  /* Only look for a generic token if the specific Graph id did not already
     fire, so one leak is not reported twice. */
  if (!findings.some((f) => f.kind === "opaque_id")) leak("opaque_id", text.match(OPAQUE_TOKEN));
  leak("cache_field", text.match(CACHE_FIELD));
  leak("cursor_token", text.match(CURSOR_TOKEN));
  leak("unfilled_slot", text.match(UNFILLED_SLOT));

  if (EMPTY_SHAPES.some((re) => re.test(text))) {
    findings.push({ kind: "empty", severity: "warn", evidence: JSON.stringify(text.slice(0, 20)) });
  } else if (text.length > BLOAT_CHARS) {
    findings.push({ kind: "bloat", severity: "warn", evidence: `${text.length} chars` });
  }

  return { findings, clean: !findings.some((f) => f.severity === "leak") };
}
