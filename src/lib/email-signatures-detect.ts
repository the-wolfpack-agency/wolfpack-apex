/**
 * Detect a user's existing email signature from their Outlook history.
 *
 * Microsoft Graph has no public read API for the user's stored Outlook
 * signatures (roaming signatures live in a hidden mailbox folder
 * accessible only via EWS / MAPI — not exposed on Graph). The
 * pragmatic substitute is to look at the last N sent messages and find
 * the longest common suffix across their plain-text bodies. That
 * suffix is by definition the user's signature, and it works whether
 * Outlook owns the signature or the user typed it manually.
 *
 * Zero LLM tokens — pure string algorithm.
 */
import { getValidToken } from "@/lib/microsoft-graph";

interface RawSentMessage {
  id: string;
  body?: { contentType?: "text" | "html"; content?: string };
  bodyPreview?: string;
  sentDateTime?: string;
}

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

export interface DetectedSignature {
  /** Plain-text version of the suffix, ready to insert. */
  text: string;
  /** How many of the sampled messages this suffix matched on. */
  matchedCount: number;
  /** Total messages we looked at. */
  sampledCount: number;
  /** Confidence 0–1 — `matchedCount / sampledCount`. */
  confidence: number;
}

export type DetectError =
  | { ok: false; code: "not_connected"; message: string }
  | { ok: false; code: "scope_missing"; message: string }
  | { ok: false; code: "no_sent_mail"; message: string }
  | { ok: false; code: "no_signature_detected"; message: string }
  | { ok: false; code: "graph_error"; status?: number; message: string };

export type DetectOk = { ok: true; signature: DetectedSignature };

export type DetectResult = DetectOk | DetectError;

/**
 * Strip HTML tags + collapse whitespace to plain text. Very narrow —
 * preserves line breaks via <br> and </p> conversion so the signature's
 * shape (multi-line) survives.
 */
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\/\s*(p|div|li|tr|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Find the longest common SUFFIX across an array of strings, line-by-line.
 * We work in lines (not characters) so we don't return partial words.
 *
 * Quoted-original blocks ("On … wrote:", "From: …") are stripped first
 * because replies have them but fresh sends don't, and they're never
 * part of a signature.
 */
export function longestCommonSuffix(bodies: string[]): string {
  if (bodies.length === 0) return "";

  const cleaned = bodies.map((b) => stripQuotedBlock(b));

  /* Build per-message reversed line lists (no trailing whitespace). */
  const reversed = cleaned.map((b) =>
    b
      .split(/\r?\n/)
      .map((l) => l.trimEnd())
      .filter((l, i, arr) => !(l === "" && (i === arr.length - 1)))
      .reverse(),
  );

  const minLen = Math.min(...reversed.map((r) => r.length));
  const sharedReversed: string[] = [];
  for (let i = 0; i < minLen; i++) {
    const candidate = reversed[0][i];
    if (reversed.every((r) => r[i] === candidate)) {
      sharedReversed.push(candidate);
    } else {
      break;
    }
  }
  if (sharedReversed.length === 0) return "";
  return sharedReversed.reverse().join("\n").trim();
}

/**
 * Remove any quoted-original block — the part Outlook adds below
 * "On {date}, {sender} wrote:" or "From: …".
 */
export function stripQuotedBlock(body: string): string {
  const markers = [
    /\n+On .+? wrote:/i,
    /\n+From:.+?$/im,
    /\n+_+\s*\n+From:/i,
    /\n+-{3,}\s*Original Message\s*-{3,}/i,
  ];
  let cut = body.length;
  for (const m of markers) {
    const match = m.exec(body);
    if (match && match.index < cut) cut = match.index;
  }
  return body.slice(0, cut);
}

/**
 * Pull the user's most recent sent messages and detect a signature.
 *
 * We sample `top` (default 5) — enough to be confident a common suffix
 * is the signature, few enough that the Graph round-trip is fast.
 */
export async function detectSignatureFromOutlook(
  userId: string,
  opts: { top?: number; minMatched?: number } = {},
): Promise<DetectResult> {
  const top = Math.min(Math.max(opts.top ?? 5, 2), 20);
  const minMatched = opts.minMatched ?? 2;

  const token = await getValidToken(userId);
  if (!token) {
    return {
      ok: false,
      code: "not_connected",
      message: "microsoft_not_connected",
    };
  }

  const select = "id,body,bodyPreview,sentDateTime";
  const order = "sentDateTime desc";
  const path =
    `me/mailFolders/sentitems/messages` +
    `?$top=${top}` +
    `&$orderby=${encodeURIComponent(order)}` +
    `&$select=${encodeURIComponent(select)}`;

  let res: Response;
  try {
    res = await fetch(`${GRAPH_BASE}/${path}`, {
      headers: { Authorization: `Bearer ${token.accessToken}` },
    });
  } catch (err) {
    return {
      ok: false,
      code: "graph_error",
      message: `network: ${(err as Error).message}`,
    };
  }

  if (res.status === 403) {
    return {
      ok: false,
      code: "scope_missing",
      message: "Mail.Read scope required to detect signatures",
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      code: "graph_error",
      status: res.status,
      message: `graph ${res.status}`,
    };
  }

  const data = (await res.json().catch(() => ({}))) as {
    value?: RawSentMessage[];
  };
  const rows = Array.isArray(data.value) ? data.value : [];
  if (rows.length === 0) {
    return {
      ok: false,
      code: "no_sent_mail",
      message: "No sent messages found",
    };
  }

  const bodies: string[] = rows.map((r) => {
    const raw = r.body?.content ?? r.bodyPreview ?? "";
    if (r.body?.contentType === "html") return htmlToPlainText(raw);
    return raw;
  });

  const suffix = longestCommonSuffix(bodies);
  /* Heuristic floor: signatures are typically ≥ 2 lines AND ≥ 6 chars
     of useful content. Below that, we likely matched on punctuation
     ("Thanks!" alone). */
  const lineCount = suffix.split("\n").filter((l) => l.trim()).length;
  if (suffix.length < 6 || lineCount < 1) {
    return {
      ok: false,
      code: "no_signature_detected",
      message: "Could not find a consistent signature in recent sent mail",
    };
  }

  /* matchedCount: count how many bodies actually end with the suffix. */
  const matchedCount = bodies.filter((b) =>
    stripQuotedBlock(b).trimEnd().endsWith(suffix),
  ).length;
  if (matchedCount < minMatched) {
    return {
      ok: false,
      code: "no_signature_detected",
      message: `Suffix only matched ${matchedCount} of ${rows.length} messages`,
    };
  }

  return {
    ok: true,
    signature: {
      text: suffix,
      matchedCount,
      sampledCount: rows.length,
      confidence: matchedCount / rows.length,
    },
  };
}
