/**
 * /api/s/[slug]/view — PUBLIC survey VIEW beacon.
 *
 * NO authentication. Fired once on mount by the responder UI to capture
 * the TOP of the survey completion funnel: a "someone opened this survey"
 * event, with the same privacy-preserving attribution we attach to a
 * submission (device / country / referrer / a truncated visitor hash).
 * Joining views to submissions is the data a hosted form SaaS can't give
 * us — view→completion rate, drop-off, per-channel attribution.
 *
 * Contract (deliberately forgiving — a view beacon must NEVER error the
 * page it's measuring):
 *   - `getPublishedSurveyBySlug` null → 404. (The only non-200; lets the
 *     client skip retrying a beacon for a survey that isn't live.)
 *   - Everything else → 200 `{ ok: true }`. Any thrown error (DB down,
 *     malformed headers) is swallowed and logged; the beacon still 200s.
 *   - Light per-ip rate limit. Views are higher volume than submits, so
 *     the budget is generous (60 / 10 min per ip-hash). In-memory, per
 *     process; exposed for tests via `_resetRateLimit`. Over budget still
 *     returns 200 (we just skip the write) — the page must never see a 429
 *     from a fire-and-forget beacon.
 *
 * Attribution derived SERVER-SIDE from request headers (never trust the
 * client for these): device via parseUserAgent, country via the Vercel
 * edge header, referrer via Referer, fingerprint via visitorHash(ip, ua).
 * Mirrors the QR-scan recorder (`@/lib/qr/scans`) so views and scans share
 * one attribution vocabulary.
 */

import { NextRequest, NextResponse } from "next/server";
import { getPublishedSurveyBySlug, recordSurveyView } from "@/lib/surveys/store";
import { parseUserAgent, visitorHash } from "@/lib/qr/scans";
import { trackEvent } from "@/lib/analytics";

export const runtime = "nodejs";
/* Never cache — every beacon must reach the DB so the view row + analytics
   land and the funnel stays accurate. */
export const dynamic = "force-dynamic";

/* ----------------------------- Rate limiter --------------------------- */

const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
/* Generous vs submits (5/10min) — views are higher volume by design. */
const RATE_LIMIT_MAX = 60;

interface RateEntry {
  count: number;
  windowStart: number;
}

// Per-process bucket keyed by ip-hash. Exposed for tests via _resetRateLimit.
const rateBucket = new Map<string, RateEntry>();

export function _resetRateLimit(): void {
  rateBucket.clear();
}

function rateLimitCheck(
  ipHash: string,
  now: number = Date.now(),
): { allowed: boolean } {
  const entry = rateBucket.get(ipHash);
  if (!entry || now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) {
    rateBucket.set(ipHash, { count: 1, windowStart: now });
    return { allowed: true };
  }
  if (entry.count >= RATE_LIMIT_MAX) {
    return { allowed: false };
  }
  entry.count += 1;
  return { allowed: true };
}

/* ----------------------------- Helpers -------------------------------- */

/** Best-effort requester IP from the standard edge/proxy headers. */
function requesterIp(headers: Headers): string {
  const fwd =
    headers.get("x-forwarded-for") ?? headers.get("x-vercel-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return (
    headers.get("x-vercel-ip") ??
    headers.get("x-real-ip") ??
    headers.get("cf-connecting-ip") ??
    "unknown"
  );
}

/** ISO country from Vercel's edge header, normalised. Null when absent. */
function edgeCountry(headers: Headers): string | null {
  const c = headers.get("x-vercel-ip-country");
  if (!c) return null;
  const trimmed = c.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(trimmed) ? trimmed : null;
}

/* ------------------------------- POST --------------------------------- */

// PUBLIC: anonymous survey view beacon. Records an aggregate view for a
// published survey; no auth by design, no PII, rate-limit guarded.
export async function POST(
  req: NextRequest,
  context: { params: Promise<{ slug: string }> },
) {
  let slug = "";
  try {
    ({ slug } = await context.params);

    const survey = await getPublishedSurveyBySlug(slug);
    if (!survey) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    const ua = req.headers.get("user-agent") ?? "";
    const ip = requesterIp(req.headers);
    const fingerprint = visitorHash(ip, ua);
    const device = parseUserAgent(ua).device;
    const country = edgeCountry(req.headers);
    const referrer = req.headers.get("referer") ?? null;

    // Generous per-ip limit. Over budget → skip the write but still 200,
    // so the page never sees an error from a fire-and-forget beacon.
    if (rateLimitCheck(visitorHash(ip, "view")).allowed) {
      await recordSurveyView({
        surveyId: survey.id,
        respondentFingerprint: fingerprint,
        device,
        country,
        referrer,
      });

      trackEvent("survey.viewed", "public", "public", {
        survey_id: survey.id,
        slug,
        device,
        // Analytics metadata is non-null; "unknown" when the edge header
        // didn't supply a country (the DB view row still stores null).
        country: country ?? "unknown",
      });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    /* A view beacon must NEVER error the page it measures. Swallow,
       log, and still report success to the client. */
    console.warn(
      `[surveys] view beacon failed (slug=${slug}):`,
      (err as Error).message,
    );
    return NextResponse.json({ ok: true });
  }
}
