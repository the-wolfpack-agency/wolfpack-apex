/**
 * /api/sites/parse-brief — drag-and-drop brief parser.
 *
 * Accepts:
 *   - JSON body { rawInput: string, clientSlug: string }  — text
 *   - multipart form with "file" + "clientSlug"           — text OR image
 *   - multipart form with "files[]" (1..10) + "clientSlug" — multi-frame
 *     wireframe set (all image/PDF) — routed through briefFromFrames so
 *     the vision pipeline sees every page in order.
 *
 * Multipart dispatch by MIME:
 *   - text/* + application/json + .md                  → existing parseBrief()
 *   - image/png,jpg,jpeg,webp + application/pdf        → briefFromImage() /
 *                                                         briefFromFrames()
 *
 * Multi-frame rules (NEW):
 *   - Max 10 frames per request (400 too_many_frames if exceeded).
 *   - Total payload <= 10 MB (same cap as single-file image path).
 *   - Every frame's MIME must be in SUPPORTED_IMAGE_MIMES; mixing a
 *     rejected MIME trips 400 unsupported_mime (text files are routed
 *     through the text path only when exactly one file is uploaded).
 *
 * Returns { brief, source, tokensUsed?, confidence, metadata? }.
 *   - source:   "heuristic" | "ai"  (text path)
 *                "vision"           (image path — single or multi)
 *   - metadata is populated on the vision path with the extracted
 *     color palette, latency, generationId, and for the multi-frame
 *     path a `frameCount` field so the learning loop can segment by
 *     page count.
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
  briefFromFrames,
  SUPPORTED_IMAGE_MIMES,
  BriefFromImageError,
  BriefFromImageAIUnavailableError,
  BriefFromImageNotConfiguredError,
} from "@/lib/brief-from-image";

const MAX_TEXT_BYTES = 5 * 1024 * 1024; // 5 MB for text inputs
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB for image/PDF wireframes
const MAX_FRAMES_PER_REQUEST = 10; // hard cap on multi-frame uploads

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

/**
 * Translate a vision-pipeline error thrown by briefFromImage or
 * briefFromFrames into a Next response. Extracted so both the single
 * and multi-frame paths stay in sync — any new error class added to
 * brief-from-image.ts only needs to be taught this one helper.
 */
function mapVisionErrorToResponse(err: unknown): NextResponse {
  if (err instanceof BriefFromImageNotConfiguredError) {
    return NextResponse.json(
      { error: (err as Error).message, reason: "ai_not_configured" },
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
    // unsupported_mime from the extractor (e.g. mixed PDF + image in a
    // future tightened rule, or the extractor rejecting a frame after
    // decode) must surface as a 400 so the UI can re-prompt. bad output
    // and invalid brief stay 422.
    if (err.reason === "unsupported_mime") {
      return NextResponse.json(
        { error: err.message, reason: err.reason },
        { status: 400 },
      );
    }
    return NextResponse.json(
      { error: err.message, reason: err.reason },
      { status: 422 },
    );
  }
  console.error("[sites/parse-brief] image path", (err as Error).message);
  return NextResponse.json(
    { error: "Failed to parse brief" },
    { status: 422 },
  );
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

    // ── Multi-frame branch: `files[]` (or `files`) entries ─────
    // When more than one file is posted under `files[]` (the field name
    // <input multiple> produces in Dropzone-style uploaders), we route
    // through briefFromFrames. A single `files[]` entry is also legal
    // and collapses back onto the same path so the client can always
    // use `files[]`.
    const rawFiles = [
      ...form.getAll("files[]"),
      ...form.getAll("files"),
    ].filter((v): v is File => v instanceof File);
    if (rawFiles.length > 0) {
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
      if (rawFiles.length > MAX_FRAMES_PER_REQUEST) {
        trackEvent("site.brief_multi_frame_rejected", user.id, user.role, {
          reason: "too_many_frames",
          frame_count: rawFiles.length,
          max_frames: MAX_FRAMES_PER_REQUEST,
        });
        return NextResponse.json(
          {
            error: `too many frames — max ${MAX_FRAMES_PER_REQUEST}`,
            reason: "too_many_frames",
          },
          { status: 400 },
        );
      }
      let totalBytes = 0;
      for (const f of rawFiles) totalBytes += f.size;
      if (totalBytes > MAX_IMAGE_BYTES) {
        trackEvent("site.brief_multi_frame_rejected", user.id, user.role, {
          reason: "too_large",
          frame_count: rawFiles.length,
          total_bytes: totalBytes,
          max_bytes: MAX_IMAGE_BYTES,
        });
        return NextResponse.json(
          {
            error: `payload too large (${MAX_IMAGE_BYTES} bytes max)`,
            reason: "too_large",
          },
          { status: 413 },
        );
      }
      // Validate MIMEs — any non-image/PDF frame rejects the whole set.
      const badFrame = rawFiles.find((f) => {
        const m = (f.type ?? "").toLowerCase();
        return !SUPPORTED_IMAGE_MIMES.has(m);
      });
      if (badFrame) {
        trackEvent("site.brief_multi_frame_rejected", user.id, user.role, {
          reason: "unsupported_mime",
          mime: (badFrame.type ?? "").toLowerCase(),
          frame_count: rawFiles.length,
        });
        return NextResponse.json(
          {
            error: `unsupported MIME type "${(badFrame.type ?? "").toLowerCase()}"`,
            reason: "unsupported_mime",
          },
          { status: 400 },
        );
      }

      // If the caller sent exactly ONE frame under files[], fall through
      // to the legacy single-file path so the existing vision + persistence
      // telemetry stays identical. Multi-frame path kicks in at 2+.
      if (rawFiles.length === 1) {
        const only = rawFiles[0];
        const mime = (only.type ?? "").toLowerCase();
        if (only.size > MAX_IMAGE_BYTES) {
          trackEvent("site.brief_image_rejected", user.id, user.role, {
            reason: "too_large",
            mime,
            size_bytes: only.size,
            max_bytes: MAX_IMAGE_BYTES,
          });
          return NextResponse.json(
            { error: `file too large (${MAX_IMAGE_BYTES} bytes max)` },
            { status: 413 },
          );
        }
        trackEvent("site.dropzone_used", user.id, user.role, {
          filename: only.name,
          size_bytes: only.size,
          mime,
          client_slug: clientSlug,
        });
        const bytes = new Uint8Array(await only.arrayBuffer());
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
              frameCount: 1,
            },
          });
        } catch (err) {
          return mapVisionErrorToResponse(err);
        }
      }

      trackEvent("site.brief_multi_frame_requested", user.id, user.role, {
        frame_count: rawFiles.length,
        total_bytes: totalBytes,
        client_slug: clientSlug,
      });

      // Build frames in received order — the uploader is responsible for
      // ordering, the route does not re-order.
      const frames: Array<{ bytes: Uint8Array; mime: string; label?: string }> = [];
      for (let i = 0; i < rawFiles.length; i++) {
        const f = rawFiles[i];
        frames.push({
          bytes: new Uint8Array(await f.arrayBuffer()),
          mime: (f.type ?? "").toLowerCase(),
          label: f.name || `page-${i + 1}`,
        });
      }
      try {
        const result = await briefFromFrames({
          frames,
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
            frameCount: frames.length,
          },
        });
      } catch (err) {
        return mapVisionErrorToResponse(err);
      }
    }

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
        return mapVisionErrorToResponse(err);
      }
    }

    // ── Text path (existing behavior) ──────────────────────────
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
