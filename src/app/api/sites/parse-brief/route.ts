/**
 * /api/sites/parse-brief — drag-and-drop brief parser.
 *
 * Accepts either:
 *   - JSON body { rawInput: string, clientSlug: string }  — text
 *   - multipart form with "file" + "clientSlug"           — text OR image
 *
 * Multipart dispatch by MIME:
 *   - text/* + application/json + .md                  → existing parseBrief()
 *   - image/png,jpg,jpeg,webp + application/pdf        → briefFromImage()
 *
 * Returns { brief, source, tokensUsed?, confidence, metadata? }.
 *   - source:   "heuristic" | "ai"  (text path)
 *                "vision"           (image path)
 *   - metadata is populated on the vision path with the extracted
 *     colour palette, latency, and generationId so the UI can link
 *     the later "accept" call back to the generation row.
 *
 * Auth required. Every parse attempt — success, failure, reject —
 * emits a tracked event so the brain learns what shapes of input we
 * handle vs. fall back on vs. reject outright. NO data lost.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { parseBrief } from "@/lib/brief-parser";
import { trackEvent } from "@/lib/analytics";
import {
  briefFromImage,
  SUPPORTED_IMAGE_MIMES,
  BriefFromImageError,
  BriefFromImageAIUnavailableError,
  BriefFromImageNotConfiguredError,
} from "@/lib/brief-from-image";

const MAX_TEXT_BYTES = 5 * 1024 * 1024; // 5 MB for text inputs
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB for image/PDF wireframes

const TEXT_MIMES = new Set([
  "text/plain",
  "text/html",
  "text/markdown",
  "application/json",
  "application/xhtml+xml",
  "",
]);

function isTextMime(mime: string): boolean {
  return TEXT_MIMES.has(mime) || mime.startsWith("text/");
}

export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const contentType = req.headers.get("content-type") ?? "";

  // ── Multipart branch: may be text OR image ─────────────────────
  if (contentType.includes("multipart/form-data")) {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return NextResponse.json({ error: "invalid body" }, { status: 400 });
    }
    const file = form.get("file");
    const clientSlug = String(form.get("clientSlug") ?? "");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "file required" }, { status: 400 });
    }
    if (!clientSlug) {
      return NextResponse.json(
        { error: "clientSlug required" },
        { status: 400 },
      );
    }
    if (!/^[a-z][a-z0-9-]{1,38}$/.test(clientSlug)) {
      return NextResponse.json(
        { error: "clientSlug must be a lowercase slug" },
        { status: 400 },
      );
    }

    const mime = (file.type ?? "").toLowerCase();

    // ── Image / PDF path ────────────────────────────────────────
    if (SUPPORTED_IMAGE_MIMES.has(mime)) {
      if (file.size > MAX_IMAGE_BYTES) {
        trackEvent("site.brief_image_rejected", user.id, user.role, {
          reason: "too_large",
          mime,
          size_bytes: file.size,
          max_bytes: MAX_IMAGE_BYTES,
        });
        return NextResponse.json(
          { error: `file too large (${MAX_IMAGE_BYTES} bytes max)` },
          { status: 413 },
        );
      }
      trackEvent("site.dropzone_used", user.id, user.role, {
        filename: file.name,
        size_bytes: file.size,
        mime,
        client_slug: clientSlug,
      });
      const bytes = new Uint8Array(await file.arrayBuffer());
      try {
        const result = await briefFromImage({
          bytes,
          mime,
          clientSlug,
          userId: user.id,
          userRole: user.role,
        });
        return NextResponse.json({
          brief: result.brief,
          source: "vision" as const,
          confidence: result.confidence,
          metadata: {
            generationId: result.generationId,
            extractedColors: result.extractedColors,
            detectedFont: result.detectedFont,
            latencyMs: result.metrics.latencyMs,
            tokensIn: result.metrics.tokensIn,
            tokensOut: result.metrics.tokensOut,
            costCents: result.metrics.costCents,
            model: result.metrics.model,
          },
        });
      } catch (err) {
        if (err instanceof BriefFromImageNotConfiguredError) {
          return NextResponse.json(
            { error: err.message, reason: "ai_not_configured" },
            { status: 503 },
          );
        }
        if (err instanceof BriefFromImageAIUnavailableError) {
          return NextResponse.json(
            { error: "vision service unavailable", reason: "ai_unavailable" },
            { status: 502 },
          );
        }
        if (err instanceof BriefFromImageError) {
          return NextResponse.json(
            { error: err.message, reason: err.reason },
            { status: 422 },
          );
        }
        console.error(
          "[sites/parse-brief] image path",
          (err as Error).message,
        );
        return NextResponse.json(
          { error: "Failed to parse brief" },
          { status: 422 },
        );
      }
    }

    // ── Text path (existing behaviour) ──────────────────────────
    if (!isTextMime(mime)) {
      trackEvent("site.brief_image_rejected", user.id, user.role, {
        reason: "unsupported_mime",
        mime,
        size_bytes: file.size,
      });
      return NextResponse.json(
        { error: `unsupported MIME type "${mime}"` },
        { status: 415 },
      );
    }
    if (file.size > MAX_TEXT_BYTES) {
      return NextResponse.json(
        { error: `file too large (${MAX_TEXT_BYTES} bytes max)` },
        { status: 413 },
      );
    }
    trackEvent("site.dropzone_used", user.id, user.role, {
      filename: file.name,
      size_bytes: file.size,
      mime,
      client_slug: clientSlug,
    });
    const rawInput = await file.text();
    if (!rawInput) {
      return NextResponse.json(
        { error: "rawInput and clientSlug required" },
        { status: 400 },
      );
    }
    try {
      const result = await parseBrief(rawInput, clientSlug, user.id, user.role);
      return NextResponse.json(result);
    } catch (err) {
      console.error("[sites/parse-brief]", (err as Error).message);
      return NextResponse.json(
        { error: "Failed to parse brief" },
        { status: 422 },
      );
    }
  }

  // ── JSON branch (unchanged) ────────────────────────────────────
  let rawInput: string;
  let clientSlug: string;
  try {
    const body = await req.json();
    rawInput = String(body.rawInput ?? "");
    clientSlug = String(body.clientSlug ?? "");
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  if (!rawInput || !clientSlug) {
    return NextResponse.json(
      { error: "rawInput and clientSlug required" },
      { status: 400 },
    );
  }
  if (!/^[a-z][a-z0-9-]{1,38}$/.test(clientSlug)) {
    return NextResponse.json(
      { error: "clientSlug must be a lowercase slug" },
      { status: 400 },
    );
  }
  try {
    const result = await parseBrief(rawInput, clientSlug, user.id, user.role);
    return NextResponse.json(result);
  } catch (err) {
    console.error("[sites/parse-brief]", (err as Error).message);
    return NextResponse.json(
      { error: "Failed to parse brief" },
      { status: 422 },
    );
  }
}
