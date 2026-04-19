/**
 * /api/public/share/[token]/comments — PUBLIC (unauth) comments endpoint.
 *
 * Path C Phase 3 · Stream R3. The share-token IS the credential (same
 * pattern as /api/public/approvals/[token]).
 *
 * POST → share-link reviewer leaves a comment on a section.
 * GET  → share-link reviewer (or the designer, on the same token) reads
 *        the open comments for the site. Rate limit is write-only.
 *
 * Safety:
 *   - `x-robots-tag: noindex` on every response path. Reviewer link
 *     must never show up in Google.
 *   - Rate limit: 20 posts per hour per nonce (higher than approvals
 *     because comments are chatty by design, but bot-level volume
 *     still trips).
 *   - Body validated with a typed 400 — never a 500 on a bad body.
 *   - Analytics emits `token_nonce` (UUID) — NEVER the signed blob.
 *   - CORS: same-origin only. No Access-Control-Allow-Origin header =
 *     browsers block cross-origin reads from third-party sites.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  loadActiveTokenRow,
  touchShareTokenAccess,
  verifyShareToken,
  getShareSecret,
} from "@/lib/share-tokens";
import {
  postComment,
  listCommentsForSite,
  CommentValidationError,
  COMMENT_BODY_MAX,
} from "@/lib/section-comments";
import { trackEvent } from "@/lib/analytics";
import { WriteQueryError } from "@/lib/db";

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
const RATE_LIMIT_MAX = 20; // comments are chatty; higher than approvals (10)
// Module-scoped; resets on deploy. Tests reset via __resetRateLimitForTests.
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

/* ----------------------------- shared auth ---------------------------- */

type VerifiedToken = {
  siteId: string;
  nonce: string;
  tokenRowId: string;
  accessCount: number;
};

async function verifyTokenOrReject(
  token: string,
): Promise<{ verified: VerifiedToken } | { rejection: NextResponse }> {
  const secret = getShareSecret();
  const verified = verifyShareToken(token, secret);
  if (!verified.ok) {
    return {
      rejection: NextResponse.json(
        { error: "Invalid or expired share link", reason: verified.reason },
        { status: 401, headers: NOINDEX_HEADERS },
      ),
    };
  }
  const row = await loadActiveTokenRow(verified.claims.nonce);
  if (!row || row.site_id !== verified.claims.siteId) {
    return {
      rejection: NextResponse.json(
        { error: "Share link has been revoked or expired", reason: "revoked_or_unknown" },
        { status: 401, headers: NOINDEX_HEADERS },
      ),
    };
  }
  return {
    verified: {
      siteId: verified.claims.siteId,
      nonce: verified.claims.nonce,
      tokenRowId: row.id,
      accessCount: row.access_count,
    },
  };
}

/* ----------------------------- POST ----------------------------------- */

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ token: string }> },
) {
  const { token } = await context.params;

  const auth = await verifyTokenOrReject(token);
  if ("rejection" in auth) return auth.rejection;
  const { siteId, nonce, tokenRowId, accessCount } = auth.verified;

  const rate = rateLimitCheck(nonce);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Too many comments — please try again later.", reason: "rate_limited" },
      {
        status: 429,
        headers: {
          ...NOINDEX_HEADERS,
          "retry-after": String(rate.retryAfterSec),
        },
      },
    );
  }

  let body: {
    pageIndex?: unknown;
    sectionIndex?: unknown;
    sectionType?: unknown;
    body?: unknown;
    actorName?: unknown;
    actorEmail?: unknown;
    parentCommentId?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body", reason: "bad_body" },
      { status: 400, headers: NOINDEX_HEADERS },
    );
  }

  // Quick shape checks before calling the lib. The lib enforces too,
  // but a clean 400 with reason="bad_body" is nicer than a generic
  // validation error for malformed client requests.
  if (!Number.isInteger(body.pageIndex) || (body.pageIndex as number) < 0) {
    return NextResponse.json(
      { error: "pageIndex must be a non-negative integer", reason: "bad_index" },
      { status: 400, headers: NOINDEX_HEADERS },
    );
  }
  if (!Number.isInteger(body.sectionIndex) || (body.sectionIndex as number) < 0) {
    return NextResponse.json(
      { error: "sectionIndex must be a non-negative integer", reason: "bad_index" },
      { status: 400, headers: NOINDEX_HEADERS },
    );
  }
  if (typeof body.body !== "string" || body.body.trim().length === 0) {
    return NextResponse.json(
      { error: "body must be a non-empty string", reason: "body_empty" },
      { status: 400, headers: NOINDEX_HEADERS },
    );
  }

  // Touch the token row + fire the access event BEFORE the write so the
  // access audit trail is preserved even if the write throws.
  try {
    await touchShareTokenAccess(tokenRowId);
  } catch {
    /* best-effort */
  }
  trackEvent("site.share_link_accessed", "public", "client", {
    site_id: siteId,
    token_nonce: nonce,
    access_count: accessCount + 1,
  });

  try {
    const record = await postComment({
      siteId,
      shareTokenId: tokenRowId,
      pageIndex: body.pageIndex as number,
      sectionIndex: body.sectionIndex as number,
      sectionType: typeof body.sectionType === "string" ? body.sectionType : undefined,
      body: body.body as string,
      actorName: typeof body.actorName === "string" ? body.actorName : undefined,
      actorEmail: typeof body.actorEmail === "string" ? body.actorEmail : undefined,
      parentCommentId:
        typeof body.parentCommentId === "string" ? body.parentCommentId : undefined,
    });

    const isReply = Boolean(body.parentCommentId);
    if (isReply) {
      trackEvent("site.comment_replied", "public", "client", {
        site_id: siteId,
        parent_comment_id: String(body.parentCommentId),
      });
    }
    trackEvent("site.comment_posted", "public", "client", {
      site_id: siteId,
      via_share_token: true,
      page_index: record.pageIndex,
      section_index: record.sectionIndex,
      section_type: record.sectionType ?? "",
      body_length: record.body.length,
      has_actor_email: record.actorEmail !== null,
    });

    return NextResponse.json(
      { comment: record },
      { status: 200, headers: NOINDEX_HEADERS },
    );
  } catch (err) {
    if (err instanceof CommentValidationError) {
      const status = err.code === "body_too_long" ? 400 : 400;
      return NextResponse.json(
        { error: err.message, reason: err.code, body_max: COMMENT_BODY_MAX },
        { status, headers: NOINDEX_HEADERS },
      );
    }
    if (err instanceof WriteQueryError) {
      return NextResponse.json(
        { error: "Failed to save comment", reason: err.code },
        { status: 503, headers: NOINDEX_HEADERS },
      );
    }
    console.error("[public-comments/POST]", (err as Error).message);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500, headers: NOINDEX_HEADERS },
    );
  }
}

/* ----------------------------- GET ------------------------------------ */

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ token: string }> },
) {
  const { token } = await context.params;

  const auth = await verifyTokenOrReject(token);
  if ("rejection" in auth) return auth.rejection;
  const { siteId } = auth.verified;

  try {
    const comments = await listCommentsForSite(siteId, { openOnly: true });
    return NextResponse.json(
      { comments },
      { status: 200, headers: NOINDEX_HEADERS },
    );
  } catch (err) {
    console.error("[public-comments/GET]", (err as Error).message);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500, headers: NOINDEX_HEADERS },
    );
  }
}
