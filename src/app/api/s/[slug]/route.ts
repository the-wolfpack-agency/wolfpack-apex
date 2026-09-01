/**
 * /api/s/[slug] — PUBLIC survey responder API.
 *
 * NO authentication. Anyone with the survey link (or a QR pointing at
 * /s/<slug>) can fetch the public survey definition and submit a
 * response. This mirrors the /q/[slug] QR-redirect precedent: public
 * surfaces live outside the (dashboard) auth wrapper and never gate on
 * a session.
 *
 * Safety layering on submit (the only write path):
 *   1. Rate limit by a hash of the requester IP — 5 submissions / 10 min
 *      per ip-hash. In-memory, per-process (single-replica Vercel Fn is
 *      fine; the response row audit catches cross-region abuse). Exposed
 *      for tests via `_resetRateLimit`.
 *   2. Survey must be PUBLISHED (`getPublishedSurveyBySlug` returns null
 *      otherwise) → 404.
 *   3. `validateAnswers` is the gate — answers are fully untrusted. On
 *      failure we emit `survey.response_rejected` and return 400 with the
 *      validation message; we never persist a response that fails it.
 *   4. On success we persist via `submitResponse`, attaching a privacy-
 *      preserving respondent fingerprint (sha256 of ip+ua, truncated —
 *      enough to spot repeat submitters without storing raw PII), emit
 *      `survey.response_submitted`, and return 200 `{ ok, id }`.
 *
 * GET returns ONLY the public-safe survey fields (slug/title/description/
 * schema) — never the owner, status, client, or internal ids.
 */

import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { getPublishedSurveyBySlug, submitResponse } from "@/lib/surveys/store";
import { validateAnswers } from "@/lib/surveys/validate";
import { parseUserAgent } from "@/lib/qr/scans";
import { trackEvent } from "@/lib/analytics";
import type { AnswerMap } from "@/lib/surveys/types";

export const runtime = "nodejs";
/* Never cache — every GET reflects the live publish state, every POST
   must touch the DB so the response row + analytics land. */
export const dynamic = "force-dynamic";

/* ----------------------------- Rate limiter --------------------------- */

const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX = 5;

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
  const fwd = headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return (
    headers.get("x-vercel-ip") ??
    headers.get("x-real-ip") ??
    headers.get("cf-connecting-ip") ??
    "unknown"
  );
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** ISO country from Vercel's edge header, normalized. Null when absent. */
function edgeCountry(headers: Headers): string | null {
  const c = headers.get("x-vercel-ip-country");
  if (!c) return null;
  const trimmed = c.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(trimmed) ? trimmed : null;
}

/** Coerce a client-supplied durationMs to a sane non-negative integer. */
function sanitizeDurationMs(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return null;
  /* Cap at 24h so a clock-skewed / hostile client can't store nonsense. */
  return Math.min(Math.round(raw), 24 * 60 * 60 * 1000);
}

/* ------------------------------- GET ---------------------------------- */

// PUBLIC: anonymous survey responder. Returns only published surveys and
// only public-safe fields (no owner/status/ids/client). No PII read.
export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ slug: string }> },
) {
  try {
    const { slug } = await context.params;
    const survey = await getPublishedSurveyBySlug(slug);
    if (!survey) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    /* Only public-safe fields — never owner/status/ids/client. */
    return NextResponse.json({
      survey: {
        slug: survey.slug,
        title: survey.title,
        description: survey.description,
        schema: survey.schema,
        theme: survey.theme ?? null,
      },
    });
  } catch (err) {
    console.warn("[surveys] GET failed:", (err as Error).message);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}

/* ------------------------------- POST --------------------------------- */

// PUBLIC: anonymous survey submission. Intentionally unauthenticated;
// guarded by per-IP rate limiting, published-survey check, and
// server-side answer validation below.
export async function POST(
  req: NextRequest,
  context: { params: Promise<{ slug: string }> },
) {
  try {
    const { slug } = await context.params;

    const ip = requesterIp(req.headers);
    const ua = req.headers.get("user-agent") ?? "";
    const ipHash = sha256Hex(ip);

    // 1. Rate limit.
    if (!rateLimitCheck(ipHash).allowed) {
      trackEvent("survey.response_rejected", "public", "public", {
        slug,
        reason: "rate_limited",
      });
      return NextResponse.json({ error: "rate_limited" }, { status: 429 });
    }

    // 2. Survey must be published.
    const survey = await getPublishedSurveyBySlug(slug);
    if (!survey) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    // 3. Parse body + validate untrusted answers.
    const body = (await req.json().catch(() => ({}))) as {
      answers?: unknown;
      durationMs?: unknown;
    };
    const answers = body?.answers;
    const result = validateAnswers(survey.schema, answers);
    if (!result.ok) {
      trackEvent("survey.response_rejected", "public", "public", {
        survey_id: survey.id,
        slug,
        reason: result.error,
      });
      return NextResponse.json({ error: result.error }, { status: 400 });
    }

    // 4. Persist + analytics. Fingerprint is a truncated sha256(ip+ua) —
    //    enough to recognize repeat submitters, never raw PII. Attribution
    //    (device/country/referrer) is derived SERVER-SIDE from headers —
    //    same vocabulary as the view beacon + QR scans — so the funnel
    //    joins cleanly; durationMs is the one client-supplied signal and is
    //    sanitised before persistence.
    const fingerprint = sha256Hex(`${ip}|${ua}`).slice(0, 32);
    const durationMs = sanitizeDurationMs(body?.durationMs);
    const device = parseUserAgent(ua).device;
    const country = edgeCountry(req.headers);
    const referrer = req.headers.get("referer") ?? null;
    const response = await submitResponse({
      surveyId: survey.id,
      answers: answers as AnswerMap,
      respondentFingerprint: fingerprint,
      durationMs,
      device,
      country,
      referrer,
    });

    trackEvent("survey.response_submitted", "public", "public", {
      survey_id: survey.id,
      slug,
    });

    return NextResponse.json({ ok: true, id: response.id });
  } catch (err) {
    console.warn("[surveys] POST failed:", (err as Error).message);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
