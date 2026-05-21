/**
 * POST /api/admin/azure-probe — fires a synthetic OCR call to prove
 * Azure Computer Vision auth works end-to-end (not just "env vars are
 * set" like /azure-status reports).
 *
 * Uses a tiny built-in PNG so the call costs 1 free-tier transaction
 * regardless of caller payload size. Returns whether the call
 * succeeded + the (typically empty) OCR result so the CTO can verify
 * keys without dragging a real screenshot into the brain.
 *
 * Capability: admin.health.probe (matches /azure-status).
 *
 * Rate-limited to one probe per 30 seconds per user — accidental
 * double-clicks shouldn't burn two transactions.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { ocrImage, isVisionConfigured } from "@/lib/azure/vision-ocr";

/* Smallest valid PNG: 1x1 transparent pixel. ~70 bytes after base64
   decode. Computer Vision will accept it and return an empty
   readResults — which proves auth + connectivity without parsing
   anything meaningful. */
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAfbLI3wAAAABJRU5ErkJggg==";

const PROBE_COOLDOWN_MS = 30_000;
const recent = new Map<string, number>();

export async function POST(req: NextRequest) {
  const auth = await requireCapability(req, "admin.health.probe");
  if (!auth.ok) return auth.response;

  const now = Date.now();
  const last = recent.get(auth.user.id) ?? 0;
  if (now - last < PROBE_COOLDOWN_MS) {
    return NextResponse.json(
      {
        error: "rate_limited",
        retry_after_sec: Math.ceil((PROBE_COOLDOWN_MS - (now - last)) / 1000),
      },
      { status: 429 },
    );
  }
  recent.set(auth.user.id, now);

  if (!isVisionConfigured()) {
    return NextResponse.json(
      {
        ok: false,
        configured: false,
        detail: "AZURE_VISION_ENDPOINT/KEY (or AZURE_COGNITIVE_*) not set in this environment",
      },
      { status: 503 },
    );
  }

  const buffer = Buffer.from(TINY_PNG_BASE64, "base64");
  const result = await ocrImage(buffer, {
    triggeredBy: auth.user.id,
    triggeredByRole: auth.user.role,
    contentType: "image/png",
  });

  if (!result.ok) {
    return NextResponse.json(
      {
        ok: false,
        configured: true,
        reason: result.reason,
        detail: result.detail,
      },
      { status: 502 },
    );
  }

  /* Success = auth worked. Tiny PNG has no text so emptyImage=true is
     EXPECTED, not a failure. Don't report it as a probe failure. */
  return NextResponse.json({
    ok: true,
    configured: true,
    empty_image_expected: true,
    pages: result.pages,
    extracted_text_length: result.text.length,
    detail: "Azure Computer Vision auth verified end-to-end with a synthetic 1x1 PNG.",
  });
}
