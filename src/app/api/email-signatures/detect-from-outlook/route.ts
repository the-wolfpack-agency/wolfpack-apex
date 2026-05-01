/**
 * POST /api/email-signatures/detect-from-outlook
 *
 * Detect the calling user's signature from their Outlook sent-items.
 *
 * Query / body params (both supported):
 *   - format: 'html' | 'text' (default 'html')
 *   - top:    sample size, 2..20 (default 5)
 *
 * Returns:
 *   200 { ok: true, signature: { ... } } — see DetectedHtmlSignature /
 *                                          DetectedSignature in
 *                                          src/lib/email-signatures-detect.ts
 *   200 { ok: false, code, message }     — non-fatal detect failures
 *                                          (no_sent_mail, no_signature_detected,
 *                                          scope_missing, not_connected, graph_error)
 *   401 { error: "Unauthorized" }        — caller has no valid token
 *
 * Why a `code` field on a 200: the UI distinguishes "we couldn't detect
 * anything" (show a hint) from "the API itself broke" (show an error).
 * Returning a structured ok:false with a typed code is the same pattern
 * used by the inbox-poller and other Microsoft surfaces here. Callers
 * inspect `body.ok` then `body.code`.
 *
 * The user must have already connected Microsoft 365 with the
 * `Mail.ReadWrite` scope (added on PR #59 of 2026-04-30). Older
 * connections that only had Mail.Send come back with code='scope_missing'.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { trackEvent } from "@/lib/analytics";
import {
  detectSignatureFromOutlook,
  detectSignatureHtmlFromOutlook,
} from "@/lib/email-signatures-detect";

function parseTop(value: string | null): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  return n;
}

export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  let format = url.searchParams.get("format");
  let top = parseTop(url.searchParams.get("top"));

  /* Body params take precedence — POST callers may prefer JSON. */
  try {
    const body = (await req.json().catch(() => null)) as
      | { format?: unknown; top?: unknown }
      | null;
    if (body && typeof body === "object") {
      if (typeof body.format === "string") format = body.format;
      if (typeof body.top === "number" && Number.isFinite(body.top)) {
        top = body.top;
      }
    }
  } catch {
    /* No JSON body — fall through with query params only. */
  }

  const useHtml = format !== "text"; // default html

  const result = useHtml
    ? await detectSignatureHtmlFromOutlook(user.id, top ? { top } : {})
    : await detectSignatureFromOutlook(user.id, top ? { top } : {});

  if (result.ok) {
    trackEvent("microsoft.signature_detected", user.id, user.role, {
      format: useHtml ? "html" : "text",
      sampled_count: result.signature.sampledCount,
      matched_count: result.signature.matchedCount,
      confidence: result.signature.confidence,
    });
    return NextResponse.json({ ok: true, signature: result.signature });
  }

  trackEvent("microsoft.signature_detected", user.id, user.role, {
    format: useHtml ? "html" : "text",
    failure_code: result.code,
  });
  return NextResponse.json({
    ok: false,
    code: result.code,
    message: result.message,
  });
}
