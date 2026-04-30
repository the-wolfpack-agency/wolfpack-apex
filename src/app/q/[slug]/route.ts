/**
 * /q/[slug] — public QR redirect endpoint.
 *
 * NO authentication. The whole point of a QR code is that anyone with
 * the printed material can scan it. We do, however, gate against:
 *   - missing slug              → blocked scan + redirect to /qr-missing
 *   - archived code             → blocked scan + redirect to /qr-missing
 *   - expired code (expires_at) → blocked scan + redirect to /qr-missing
 *
 * /qr-missing is a public route (NOT inside the dashboard auth wrapper)
 * so anonymous scanners with no Instinct session land on a friendly page
 * instead of being kicked to /login.
 *
 * Active codes get a 302 to the configured target URL with UTM params
 * appended so the destination's analytics see the offline campaign.
 *
 * Geo is sourced from Vercel edge headers (`x-vercel-ip-country` etc.)
 * which are populated for both edge and nodejs runtimes — we don't need
 * the deprecated `request.geo` property.
 */

import { NextRequest, NextResponse } from "next/server";
import { getCodeBySlug, appendUtm } from "@/lib/qr/codes";
import { recordScan } from "@/lib/qr/scans";
import { trackEvent } from "@/lib/analytics";

export const runtime = "nodejs";
/* Don't cache the redirect — every scan must touch the DB so we can
   record the analytics row. */
export const dynamic = "force-dynamic";

function extractGeo(headers: Headers): {
  country?: string;
  region?: string;
  city?: string;
} {
  const country = headers.get("x-vercel-ip-country") ?? undefined;
  const region = headers.get("x-vercel-ip-country-region") ?? undefined;
  const cityRaw = headers.get("x-vercel-ip-city") ?? undefined;
  /* Vercel URL-encodes the city header. */
  const city = cityRaw ? decodeURIComponent(cityRaw) : undefined;
  return { country, region, city };
}

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ slug: string }> },
) {
  const { slug } = await context.params;
  const code = await getCodeBySlug(slug);

  const now = new Date();
  const isExpired =
    code?.expiresAt !== null && code?.expiresAt !== undefined
      ? new Date(code.expiresAt) < now
      : false;
  const isArchived = code?.archivedAt !== null && code?.archivedAt !== undefined;
  const isBlocked = !code || isArchived || isExpired;

  if (isBlocked) {
    /* Record a blocked scan ONLY when we have a code id to associate
       with. Truly missing slugs have no FK target. */
    if (code?.id) {
      void recordScan({
        codeId: code.id,
        blocked: true,
        headers: req.headers,
        geo: extractGeo(req.headers),
      });
    }
    /* Always fire the analytics event so dashboards count blocked
       attempts even for typoed/missing slugs. */
    trackEvent(
      "assistant.qr_scan_recorded",
      code?.createdByUserId ?? "anonymous",
      "public",
      {
        slug,
        blocked: true,
        reason: !code
          ? "not_found"
          : isArchived
            ? "archived"
            : "expired",
      },
    );
    return NextResponse.redirect(new URL("/qr-missing", req.url), 302);
  }

  /* Active code — record the scan, append UTM, redirect. recordScan
     is awaited so the analytics row lands before the response, but
     wrapped so a DB failure never blocks the user's redirect. */
  void recordScan({
    codeId: code.id,
    blocked: false,
    headers: req.headers,
    geo: extractGeo(req.headers),
  });
  trackEvent(
    "assistant.qr_scan_recorded",
    code.createdByUserId ?? "anonymous",
    "public",
    { slug, blocked: false },
  );

  const target = appendUtm(code.targetUrl, code.utmCampaign);
  return NextResponse.redirect(target, 302);
}
