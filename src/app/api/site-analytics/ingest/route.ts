/**
 * POST /api/site-analytics/ingest
 *
 * Server-to-server ingest for the OGIAM marketing site's usage telemetry. The
 * marketing site forwards its closed-vocabulary signal events here (from its own
 * server, not the browser), so site usage lands in our own platform and feeds
 * the admin Site Analytics heatmap. No third-party analytics product.
 *
 * Security posture (this is a PUBLIC endpoint on the app, so it is locked down):
 *   - Shared-secret header `x-ingest-token` must match SITE_ANALYTICS_INGEST_TOKEN
 *     (constant-time compare). No token configured -> 503 (disabled), never open.
 *   - Closed event vocabulary only; unknown types are 400.
 *   - No PII accepted or stored: only event type, path, 2-letter country,
 *     referrer host, and a small bounded props bag. Inputs are length-capped.
 *   - Global rate limit so a leaked token cannot flood the table.
 *   - Never trusts request-derived identity; writes anonymous rows.
 *
 * Responses: 200 { ok }, 400 invalid, 401 bad token, 429 rate limited,
 * 503 not configured.
 */

import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { isSiteEventType, recordSiteEvent } from "@/lib/site-analytics";

const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = 600; // generous for a marketing site; bounds abuse.
let windowStart = 0;
let windowCount = 0;

export function _resetIngestRateLimit(): void {
  windowStart = 0;
  windowCount = 0;
}

function rateLimited(now: number): boolean {
  if (now - windowStart >= WINDOW_MS) {
    windowStart = now;
    windowCount = 1;
    return false;
  }
  windowCount += 1;
  return windowCount > MAX_PER_WINDOW;
}

/** Constant-time string compare that never throws on length mismatch. */
function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function cap(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (t.length === 0) return null;
  return t.length > max ? t.slice(0, max) : t;
}

export async function POST(req: NextRequest) {
  const expected = process.env.SITE_ANALYTICS_INGEST_TOKEN;
  if (!expected) {
    return NextResponse.json({ ok: false, error: "ingest_disabled" }, { status: 503 });
  }

  const provided = req.headers.get("x-ingest-token") || "";
  if (!tokenMatches(provided, expected)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  if (rateLimited(Date.now())) {
    return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ ok: false, error: "invalid_body" }, { status: 400 });
  }
  const b = body as Record<string, unknown>;

  if (!isSiteEventType(b.type)) {
    return NextResponse.json({ ok: false, error: "unknown_event_type" }, { status: 400 });
  }

  // Coarse, non-identifying props only; bounded to avoid an oversized row.
  const props: Record<string, string | number | boolean> = {};
  if (b.props && typeof b.props === "object" && !Array.isArray(b.props)) {
    for (const [k, v] of Object.entries(b.props as Record<string, unknown>).slice(0, 12)) {
      if (typeof v === "string") props[k] = v.slice(0, 120);
      else if (typeof v === "number" || typeof v === "boolean") props[k] = v;
    }
  }

  await recordSiteEvent({
    eventType: b.type,
    path: cap(b.path, 256),
    country: cap(b.country, 4),
    referrerHost: cap(b.referrer, 256),
    props,
  });

  return NextResponse.json({ ok: true });
}
