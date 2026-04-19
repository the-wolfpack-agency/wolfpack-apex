/**
 * /api/public/approvals/[token] — PUBLIC (unauth) endpoint.
 *
 * Called from the /share/[token] page when a client clicks Approve
 * or Request changes. The signed token IS the authentication: it
 * encodes the siteId + nonce, which we then look up in
 * apex_share_tokens to enforce revocation + expiry.
 *
 * Safety:
 *   - `noindex` response headers so crawlers never cache a token.
 *   - Rate limit by nonce (in-memory sliding window, 10 posts / hour).
 *     A real reviewer clicks once; >10 POSTs in an hour is a bot. We
 *     use in-memory here because the guard is best-effort (the DB row
 *     is still the final source of truth — we just don't want to
 *     create unbounded "changes_requested" rows from automation).
 *   - Body is strictly validated — extra fields are silently dropped.
 *   - Analytics emits `token_nonce` (UUID) never the signed blob.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  loadActiveTokenRow,
  touchShareTokenAccess,
  verifyShareToken,
  getShareSecret,
} from "@/lib/share-tokens";
import { recordApproval } from "@/lib/site-approvals";
import { trackEvent } from "@/lib/analytics";

const NOINDEX_HEADERS = {
  "x-robots-tag": "noindex, nofollow",
  "cache-control": "no-store",
};

/* ----------------------------- rate limit ----------------------------- */

interface RateBucket {
  windowStart: number;
  count: number;
}
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const RATE_LIMIT_MAX = 10;
// Intentionally module-scoped; resets on deploy. Tests can reset via
// `__resetRateLimitForTests` to assert the 11th call 429s.
const rateLimitState = new Map<string, RateBucket>();

export function __resetRateLimitForTests(): void {
  rateLimitState.clear();
}

function rateLimitCheck(nonce: string): { allowed: boolean; retryAfterSec: number } {
  const now = Date.now();
  const bucket = rateLimitState.get(nonce);
  if (!bucket || now - bucket.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitState.set(nonce, { windowStart: now, count: 1 });
    return { allowed: true, retryAfterSec: 0 };
  }
  bucket.count += 1;
  if (bucket.count > RATE_LIMIT_MAX) {
    const retryAfterSec = Math.max(
      1,
      Math.ceil((RATE_LIMIT_WINDOW_MS - (now - bucket.windowStart)) / 1000),
    );
    return { allowed: false, retryAfterSec };
  }
  return { allowed: true, retryAfterSec: 0 };
}

/* ----------------------------- POST ----------------------------------- */

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ token: string }> },
) {
  const { token } = await context.params;

  // 1. Cryptographic verification (pure — no DB).
  const secret = getShareSecret();
  const verified = verifyShareToken(token, secret);
  if (!verified.ok) {
    return NextResponse.json(
      { error: "Invalid or expired share link", reason: verified.reason },
      { status: 401, headers: NOINDEX_HEADERS },
    );
  }
  const { siteId, nonce } = verified.claims;

  // 2. DB verification — revocation + existence + active expiry.
  const row = await loadActiveTokenRow(nonce);
  if (!row || row.site_id !== siteId) {
    return NextResponse.json(
      { error: "Share link has been revoked or expired", reason: "revoked_or_unknown" },
      { status: 401, headers: NOINDEX_HEADERS },
    );
  }

  // 3. Rate limit (by nonce — one reviewer per link, bots > threshold).
  const rate = rateLimitCheck(nonce);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Too many requests — please try again later.", reason: "rate_limited" },
      {
        status: 429,
        headers: {
          ...NOINDEX_HEADERS,
          "retry-after": String(rate.retryAfterSec),
        },
      },
    );
  }

  // 4. Parse + validate the body.
  let body: {
    state?: unknown;
    actorName?: unknown;
    actorEmail?: unknown;
    comment?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body", reason: "bad_body" },
      { status: 400, headers: NOINDEX_HEADERS },
    );
  }
  const state = body.state;
  if (state !== "approved" && state !== "changes_requested") {
    return NextResponse.json(
      { error: "state must be 'approved' or 'changes_requested'", reason: "bad_state" },
      { status: 400, headers: NOINDEX_HEADERS },
    );
  }

  const actorName = typeof body.actorName === "string" ? body.actorName : undefined;
  const actorEmail = typeof body.actorEmail === "string" ? body.actorEmail : undefined;
  const comment = typeof body.comment === "string" ? body.comment : undefined;

  // 5. Touch the share-token row + fire access event BEFORE recording
  //    the approval so even a recordApproval-side failure leaves the
  //    access audit trail intact.
  try {
    await touchShareTokenAccess(row.id);
  } catch {
    /* best-effort */
  }
  trackEvent("site.share_link_accessed", "public", "client", {
    site_id: siteId,
    token_nonce: nonce,
    access_count: row.access_count + 1,
  });

  // 6. Record the approval + return the shape the /share page expects.
  const record = await recordApproval({
    siteId,
    state,
    actorName,
    actorEmail,
    comment,
    shareTokenRowId: row.id,
    userRole: "client",
  });

  return NextResponse.json(
    { record },
    { status: 200, headers: NOINDEX_HEADERS },
  );
}
