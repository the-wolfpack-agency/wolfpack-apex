/**
 * /api/public/forms/[siteId]/submit — PUBLIC contact-form receiver.
 *
 * UNAUTH endpoint. Cross-origin by design — the deployed
 * wolfpack-{slug}.vercel.app site (or any verified custom domain) POSTs
 * directly to this route. The Origin header is the ONLY thing that
 * separates "legitimate form submission from the client's site" from
 * "anyone on the internet"; we validate it against preview_url +
 * verified custom domains in `submitForm()`.
 *
 * Handlers:
 *   - POST    accepts `application/json` or `application/x-www-form-urlencoded`
 *   - OPTIONS CORS preflight — echoes Origin only if allowed
 *
 * Safety:
 *   - No `fetch` / no outbound cross-origin calls (email is fire-and-forget
 *     after the response is sent).
 *   - Never stores raw IPs. `ipHash = sha256(ip + INSTINCT_IP_HASH_SALT)`.
 *   - Never logs the recipient email in analytics.
 *   - Rate-limited per ip_hash (5 per 15 min) inside submitForm().
 *
 * Status mapping:
 *   ok                        → 200
 *   honeypot_tripped          → 200 (decoy — don't let bots learn)
 *   origin_not_allowed        → 403
 *   rate_limited              → 429 with Retry-After
 *   missing_required_field    → 400
 *   unexpected_field          → 400
 *   too_many_fields           → 413
 *   field_too_long            → 413
 *   site_not_found            → 404
 *   no_contact_form           → 409
 *   no_recipient              → 503  (server misconfig — designer needs to set recipientEmail)
 */

import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import {
  submitForm,
  defaultGetSite,
  defaultListVerifiedDomains,
  normalizeOrigin,
  type FormSubmitReason,
} from "@/lib/site-forms";

function statusForReason(reason: FormSubmitReason): number {
  switch (reason) {
    case "ok":
    case "honeypot_tripped":
      return 200;
    case "missing_required_field":
    case "unexpected_field":
      return 400;
    case "origin_not_allowed":
      return 403;
    case "site_not_found":
      return 404;
    case "no_contact_form":
      return 409;
    case "too_many_fields":
    case "field_too_long":
      return 413;
    case "rate_limited":
      return 429;
    case "no_recipient":
      return 503;
    default:
      return 500;
  }
}

/**
 * Compute an opaque IP hash suitable for rate limit keying. We never
 * store or log the raw value. Falls back to "unknown" when behind a
 * proxy without X-Forwarded-For — callers just get bucketed together.
 */
function computeIpHash(req: NextRequest): string {
  const xff = req.headers.get("x-forwarded-for");
  const raw =
    (xff?.split(",")[0] ?? "").trim() ||
    (req as unknown as { ip?: string }).ip ||
    "unknown";
  const salt = process.env.INSTINCT_IP_HASH_SALT ?? "dev-salt";
  return createHash("sha256").update(`${raw}::${salt}`).digest("hex");
}

/**
 * Parse body as JSON or form-urlencoded. Static HTML pages frequently
 * POST as `application/x-www-form-urlencoded` unless the designer opts
 * into JSON. Both surface as `Record<string, string>` for the library.
 * Unknown content-types are treated as empty payload — the field
 * validator below will 400 that cleanly.
 */
async function parseBody(req: NextRequest): Promise<Record<string, string>> {
  const contentType = (req.headers.get("content-type") ?? "").toLowerCase();
  if (contentType.includes("application/json")) {
    try {
      const parsed = (await req.json()) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof v === "string") out[k] = v;
        }
        return out;
      }
      return {};
    } catch {
      return {};
    }
  }
  if (contentType.includes("application/x-www-form-urlencoded")) {
    try {
      const text = await req.text();
      const params = new URLSearchParams(text);
      const out: Record<string, string> = {};
      for (const [k, v] of params.entries()) out[k] = v;
      return out;
    } catch {
      return {};
    }
  }
  // Treat anything else as empty. The field validator will return a
  // clean 400 `missing_required_field` instead of a 500.
  return {};
}

/**
 * CORS headers — we only echo the Origin when it's in the allowlist.
 * `Access-Control-Allow-Origin: null` (or no header) causes the browser
 * to block the response, which is exactly what we want for a bad origin.
 */
async function corsHeaders(
  siteId: string,
  origin: string | null,
): Promise<Headers> {
  const headers = new Headers();
  headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  headers.set("Access-Control-Max-Age", "600");
  headers.set("Vary", "Origin");

  if (!origin) return headers;

  // Load site + verified domains so preflight honors the same allowlist
  // as POST. If the site doesn't exist we don't echo Origin, and the
  // preflight still succeeds (204) — the browser will just refuse to
  // send the real POST.
  try {
    const site = await defaultGetSite(siteId);
    if (!site) return headers;
    const verified = await defaultListVerifiedDomains(siteId);
    const allowed = new Set<string>();
    const pvHost = normalizeOrigin(site.preview_url);
    if (pvHost) allowed.add(pvHost);
    for (const d of verified) {
      const h = normalizeOrigin(d);
      if (h) allowed.add(h);
    }
    const normalized = normalizeOrigin(origin);
    if (normalized && allowed.has(normalized)) {
      headers.set("Access-Control-Allow-Origin", origin);
    }
  } catch {
    // Swallow — preflight with no allow-origin is safe.
  }
  return headers;
}

export async function OPTIONS(
  req: NextRequest,
  context: { params: Promise<{ siteId: string }> },
): Promise<NextResponse> {
  const { siteId } = await context.params;
  const origin = req.headers.get("origin");
  const headers = await corsHeaders(siteId, origin);
  return new NextResponse(null, { status: 204, headers });
}

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ siteId: string }> },
): Promise<NextResponse> {
  const { siteId } = await context.params;
  const origin = req.headers.get("origin") ?? "";
  const userAgent = req.headers.get("user-agent");
  const ipHash = computeIpHash(req);
  const payload = await parseBody(req);

  const result = await submitForm({
    siteId,
    payload,
    origin,
    ipHash,
    userAgent,
  });

  const headers = await corsHeaders(siteId, origin);
  const status = statusForReason(result.reason);

  if (result.reason === "rate_limited" && result.retryAfterSec) {
    headers.set("Retry-After", String(result.retryAfterSec));
  }

  // Response body shape:
  //   success: { ok: true, submissionId }
  //   failure: { error: <reason>, ok: false }
  // We never echo the payload back — it's not useful for the client and
  // would make XSS echo attacks easier to chain.
  if (result.ok) {
    return NextResponse.json(
      result.reason === "ok"
        ? { ok: true, submissionId: result.submissionId ?? null }
        : { ok: true }, // honeypot_tripped — decoy shape
      { status, headers },
    );
  }
  return NextResponse.json(
    {
      ok: false,
      error: result.reason,
      ...(result.retryAfterSec ? { retryAfterSec: result.retryAfterSec } : {}),
    },
    { status, headers },
  );
}
