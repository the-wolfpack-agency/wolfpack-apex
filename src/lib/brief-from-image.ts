/**
 * brief-from-image — wireframe image(s)/PDF → SiteBrief orchestrator.
 *
 * Flow:
 *   1. Route hands us raw bytes + MIME(s) + user context.
 *      - Single image path: `briefFromImage({ bytes, mime, ... })`
 *      - Multi-frame path : `briefFromFrames({ frames: [...], ... })`
 *        where `frames` is either N images (one per wireframe page) OR
 *        a single PDF (pages handled by the vision model directly).
 *   2. We extract a deterministic colour palette from the FIRST frame
 *      (documented choice: first frame is the "hero" of the designer's
 *      set — the page users land on). Palette extraction never needs
 *      the LLM.
 *   3. We send a SINGLE vision call to Claude with N image blocks OR
 *      one document block (we NEVER loop-call per frame — cost/efficiency
 *      is a hard requirement). The system prompt instructs the model to
 *      emit one `pages[]` entry per input frame/PDF page.
 *   4. We merge the palette into the brief's theme (palette wins over
 *      the model's guess), validate with validateBrief(), and persist a
 *      generation row + analytics event so the brain never loses a
 *      wireframe → brief attempt.
 *
 * `briefFromImage` is preserved as the single-frame entry point and is
 * now a thin wrapper over `briefFromFrames` so every call path shares
 * one orchestrator.
 *
 * Error modes — each is distinct so the route can surface actionable
 * messages rather than "something went wrong":
 *   - BriefFromImageNotConfiguredError  → ANTHROPIC_API_KEY missing
 *   - BriefFromImageAIUnavailableError  → model call failed / timed out
 *   - BriefFromImageError(reason)       → malformed, invalid, or bad input
 *       reasons: "bad_ai_output" | "brief_invalid" | "unsupported_mime"
 *              | "no_frames" | "mixed_sources"
 *
 * Every error path still emits an analytics event. No data lost.
 */

import { createHash, randomUUID } from "node:crypto";
import { trackEvent } from "@/lib/analytics";
import {
  validateBrief,
  BriefValidationError,
  type SiteBrief,
  type SiteTheme,
  type SiteThemeColors,
} from "@/lib/sites-schema";
import { extractPalette, paletteToTheme, type Palette } from "@/lib/image-palette";
import { insertBriefGeneration } from "@/lib/brief-generations";
import {
  getAcceptedExemplars,
  exemplarsToPromptBlock,
} from "@/lib/brief-exemplars";

/* ------------------------------ Constants ----------------------------- */

// Anthropic model with vision. Matches the brief-edit.ts convention of
// pinning a named version string so the cost-usd calc + migration tests
// stay aligned when we bump it. Haiku 4.5 carries vision; brief-edit
// already uses it so we keep the cost model aligned. If a future release
// moves brief-edit to Sonnet we should revisit.
export const BRIEF_FROM_IMAGE_MODEL = "claude-haiku-4-5-20251001";

// Same list-price numbers the brief-edit.ts cost calc uses. USD per 1M.
const HAIKU_INPUT_USD_PER_MTOK = 1.0;
const HAIKU_OUTPUT_USD_PER_MTOK = 5.0;

export const SUPPORTED_IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "application/pdf",
]);

const PDF_MIME = "application/pdf";

/* -------------------------------- Types ------------------------------- */

export interface BriefFromImageInput {
  bytes: Uint8Array;
  mime: string;
  clientSlug: string;
  userId: string;
  userRole: string;
  ai?: VisionCaller;
}

export interface BriefFrame {
  bytes: Uint8Array;
  mime: string;
  /** Optional designer-supplied label (e.g. "home", "about"). Not passed
   * to the model — we use route inference from visible content instead —
   * but logged in analytics so the brain can correlate designer intent
   * with model output. */
  label?: string;
}

export interface BriefFromFramesInput {
  frames: BriefFrame[];
  clientSlug: string;
  userId: string;
  userRole: string;
  ai?: VisionCaller;
}

export interface BriefFromImageMetrics {
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
  costCents: number;
  model: string;
}

export interface BriefFromImageResult {
  generationId: string;
  brief: SiteBrief;
  metrics: BriefFromImageMetrics;
  extractedColors: string[];
  detectedFont: string | null;
  confidence: "low" | "medium" | "high";
}

/** Deterministic classification of the input set — powers `source_kind`
 * analytics so dashboards can slice by upload shape. */
export type BriefSourceKind = "image" | "images_multi" | "pdf";

/* ------------------------------- Errors ------------------------------- */

export class BriefFromImageError extends Error {
  constructor(
    message: string,
    public reason:
      | "bad_ai_output"
      | "brief_invalid"
      | "unsupported_mime"
      | "no_frames"
      | "mixed_sources",
  ) {
    super(message);
    this.name = "BriefFromImageError";
  }
}

export class BriefFromImageAIUnavailableError extends Error {
  constructor(message = "vision caller returned no usable response") {
    super(message);
    this.name = "BriefFromImageAIUnavailableError";
  }
}

export class BriefFromImageNotConfiguredError extends Error {
  constructor(message = "ANTHROPIC_API_KEY is not set — vision disabled") {
    super(message);
    this.name = "BriefFromImageNotConfiguredError";
  }
}

/* ----------------------------- Vision caller -------------------------- */

export interface VisionCallResult {
  content: string;
  tokensIn: number;
  tokensOut: number;
  model: string;
}

/** Individual content block passed to the vision model — either an
 * image frame or a single PDF document block. Ordered = page order. */
export interface VisionContentBlock {
  kind: "image" | "document";
  mediaType: string;
  base64Data: string;
}

export interface VisionCallInput {
  systemPrompt: string;
  userText: string;
  /** Ordered content blocks. Length >= 1. For a single image this has
   * one image block; for N images N image blocks; for a PDF one
   * document block. */
  frames: VisionContentBlock[];
  /** Back-compat fields populated with frames[0] so any caller still
   * inspecting the old single-frame shape continues to work. New code
   * should read `frames` and ignore these. */
  mediaType: string;
  base64Data: string;
}

export type VisionCaller = (
  input: VisionCallInput,
) => Promise<VisionCallResult | null>;

/**
 * Default vision caller: raw fetch to Claude Messages API with N image
 * content blocks OR one document block. Mirrors the pattern in
 * brief-edit.ts so ops only has to trust one codepath to Anthropic.
 */
export const defaultVisionCaller: VisionCaller = async ({
  systemPrompt,
  userText,
  frames,
}) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new BriefFromImageNotConfiguredError();
  try {
    const content: Array<Record<string, unknown>> = frames.map((f) => ({
      type: f.kind,
      source: {
        type: "base64",
        media_type: f.mediaType,
        data: f.base64Data,
      },
    }));
    content.push({ type: "text", text: userText });

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: BRIEF_FROM_IMAGE_MODEL,
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: "user", content }],
      }),
    });
    if (!r.ok) return null;
    const data = await r.json();
    return {
      content: data.content?.[0]?.text ?? "",
      tokensIn: data.usage?.input_tokens ?? 0,
      tokensOut: data.usage?.output_tokens ?? 0,
      model: (data.model as string) ?? BRIEF_FROM_IMAGE_MODEL,
    };
  } catch {
    return null;
  }
};

/* ----------------------------- System prompt -------------------------- */

const SYSTEM_PROMPT = `You extract a website brief from a single wireframe or design mock-up image. The image shows what someone WANTS their site to look like — boxes, text, arrows are all fair game.

Return JSON matching this TypeScript shape exactly:

interface SiteBrief {
  client: string;                       // leave this as the placeholder value the caller provides
  product: { name: string; tagline?: string; supportEmail?: string };
  theme?: {
    colors?: { primary?: string; accent?: string; bg?: string; fg?: string; muted?: string };  // 6-digit hex only, e.g. "#1f2937"
    font?: { family?: string };
  };
  pages: Array<{
    route: string;                      // starts with /
    title?: string;
    sections: Array<
      | { type: "hero"; heading: string; body?: string; cta?: { label: string; href: string }; backgroundImage?: string }
      | { type: "text"; heading?: string; body: string }
      | { type: "callout"; body: string }
      | { type: "banner"; heading: string; body?: string }
      | { type: "stats"; heading?: string; items: Array<{ label: string; value: number; suffix?: string; prefix?: string }> }
      | { type: "cards"; heading?: string; items: Array<{ title: string; body?: string; badge?: string; accent?: boolean }> }
      | { type: "gallery"; heading?: string; images: Array<{ src: string; alt?: string }> }
      | { type: "quote"; body: string; attribution?: string }
      | { type: "video"; videoUrl: string; heading?: string }
      | { type: "testimonial"; items: Array<{ quote: string; authorName: string; authorTitle?: string }> }
      | { type: "pricing"; items: Array<{ name: string; price: string; features: string[]; highlighted?: boolean }> }
      | { type: "faq"; items: Array<{ question: string; answer: string }> }
    >;
  }>;
  contactForm?: { fields: string[] };
}

RULES:
- Detect EVERY visible section type: hero, stats, cards, testimonial, pricing, faq, video, gallery, text, callout, banner, quote.
- Extract any copy you can read from the image — headings, body, CTA labels. If illegible, invent a short plausible placeholder that fits the visual hierarchy.
- Visual hierarchy: the largest, boldest text in the top band is the hero heading. A button-styled element is a CTA. Small grey text is body/muted copy.
- If you can infer brand colour hints from the mock-up (primary button colour, accent stripe, page background, body-text colour), put them in theme.colors as 6-digit hex. The caller will override with measured palette colours, so hints are guidance only.
- stats.items[].value MUST be a number (no units; put "K"/"M"/"B" etc. in suffix).
- gallery.images MUST be an array (empty is fine).
- Always include at least one hero section on the home page even if the image is minimal.
- Output ONLY valid JSON, no markdown fences, no commentary.

MULTI-FRAME RULES:
- If you receive multiple images, EACH IMAGE is a distinct website page. Treat them in the order received.
- If you receive a PDF, EACH PAGE of the PDF is a distinct website page. Treat them in order.
- Produce exactly one entry in \`pages: []\` per input frame/page. Route them /, /about, /services, /contact etc. in sensible order based on visible content.
- If two frames clearly depict the same page (e.g. same heading), merge their sections.`;

/* ----------------------------- Helpers -------------------------------- */

function stripJsonFences(raw: string): string {
  return raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
}

function computeCostCents(tokensIn: number, tokensOut: number): number {
  const usd =
    (tokensIn / 1_000_000) * HAIKU_INPUT_USD_PER_MTOK +
    (tokensOut / 1_000_000) * HAIKU_OUTPUT_USD_PER_MTOK;
  return Math.round(usd * 100);
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

/** Concatenate N Uint8Arrays into one buffer. Used to build a single
 * stable sha256 across multi-frame uploads so identical batches dedupe. */
function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

/** Deterministic classification of the input set. Input has already been
 * validated: no mixed sources, at least one frame, all MIMEs supported. */
function classifySourceKind(frames: BriefFrame[]): BriefSourceKind {
  if (frames.length === 1 && frames[0].mime === PDF_MIME) return "pdf";
  if (frames.length === 1) return "image";
  return "images_multi";
}

/**
 * Merge the extracted palette into the brief's theme. Palette wins over
 * the model's guess — colours you CAN measure beat colours you GUESS at.
 * If the palette is empty (JPEG decode, etc.) we keep whatever the model
 * supplied. Existing font hint from the model is preserved.
 */
export function mergePaletteIntoBrief(
  brief: SiteBrief,
  palette: Palette,
): SiteBrief {
  const theme = (brief.theme ?? {}) as SiteTheme;
  const existingColors = (theme.colors ?? {}) as SiteThemeColors;
  if (palette.swatches.length === 0) {
    // Nothing measured — return as-is. Preserves model-supplied hints.
    return brief;
  }
  const measured = paletteToTheme(palette);
  const merged: SiteThemeColors = {
    primary: measured.primary ?? existingColors.primary,
    accent: measured.accent ?? existingColors.accent,
    bg: measured.bg ?? existingColors.bg,
    fg: measured.fg ?? existingColors.fg,
    muted: measured.muted ?? existingColors.muted,
  };
  return {
    ...brief,
    theme: {
      ...theme,
      colors: merged,
    },
  };
}

/* --------------------------- Main (frames) ---------------------------- */

/**
 * Multi-frame orchestrator. Accepts 1..N image frames OR exactly one
 * PDF frame. Every call emits one vision request — never a loop.
 */
export async function briefFromFrames(
  input: BriefFromFramesInput,
): Promise<BriefFromImageResult> {
  const { frames, clientSlug, userId, userRole } = input;
  const ai = input.ai ?? defaultVisionCaller;
  const generationId = `site_brief_gen_${randomUUID()}`;

  /* --- 1. Validate input shape --- */

  if (!Array.isArray(frames) || frames.length === 0) {
    trackEvent("site.brief_image_rejected", userId, userRole, {
      reason: "no_frames",
      frame_count: 0,
    });
    throw new BriefFromImageError("no frames provided", "no_frames");
  }

  // Reject any unsupported MIME before we do any work — analytics fire
  // per-rejection so we can see exactly which designers are sending
  // which unsupported formats.
  for (const f of frames) {
    if (!SUPPORTED_IMAGE_MIMES.has(f.mime)) {
      trackEvent("site.brief_image_rejected", userId, userRole, {
        reason: "unsupported_mime",
        mime: f.mime,
        size_bytes: f.bytes.byteLength,
        frame_count: frames.length,
      });
      throw new BriefFromImageError(
        `unsupported MIME type "${f.mime}"`,
        "unsupported_mime",
      );
    }
  }

  const hasPdf = frames.some((f) => f.mime === PDF_MIME);
  const hasImage = frames.some((f) => f.mime !== PDF_MIME);
  if (hasPdf && hasImage) {
    trackEvent("site.brief_image_rejected", userId, userRole, {
      reason: "mixed_sources",
      frame_count: frames.length,
    });
    throw new BriefFromImageError(
      "cannot mix PDF and image frames in one batch",
      "mixed_sources",
    );
  }
  if (hasPdf && frames.length > 1) {
    // A multi-PDF batch is also rejected — PDF pages are handled by
    // the model, so N PDFs would be an ambiguous request.
    trackEvent("site.brief_image_rejected", userId, userRole, {
      reason: "mixed_sources",
      frame_count: frames.length,
      pdf_count: frames.length,
    });
    throw new BriefFromImageError(
      "cannot batch multiple PDFs — submit one PDF at a time",
      "mixed_sources",
    );
  }

  /* --- 2. Derive deterministic metadata --- */

  const sourceKind = classifySourceKind(frames);
  // Concatenated bytes drive sha256 + size — identical multi-frame
  // uploads dedupe, partial overlaps do not (by design).
  const concatenated = concatBytes(frames.map((f) => f.bytes));
  const sourceSha256 = sha256Hex(concatenated);
  const sourceSize = concatenated.byteLength;
  // source_mime stored on the generation row: for multi-image we pick
  // the first frame's mime (validated above to be a supported image).
  const sourceMime = frames[0].mime;

  trackEvent("site.brief_generation_requested", userId, userRole, {
    generation_id: generationId,
    mime: sourceMime,
    size_bytes: sourceSize,
    sha256: sourceSha256,
    frame_count: frames.length,
    source_kind: sourceKind,
  });

  /* --- 3. Palette extraction — FIRST frame only (documented) --- */
  // First frame = the designer's "hero" page. Extracting a palette per
  // frame would multiply decode cost without improving theme quality:
  // one consistent theme across all pages is the designer's intent.
  const palette = extractPalette(frames[0].bytes);

  /* --- 4. Build vision content blocks --- */

  const contentBlocks: VisionContentBlock[] = frames.map((f) => ({
    kind: f.mime === PDF_MIME ? "document" : "image",
    mediaType: f.mime,
    base64Data: bytesToBase64(f.bytes),
  }));

  const userText = buildUserText(clientSlug, frames, sourceKind);

  // Learning primer: pull up to 3 accepted briefs for this client and
  // inject them as few-shot context. getAcceptedExemplars is best-effort
  // — it handles its own analytics (site.brief_exemplars_served / _empty)
  // and returns [] on any DB failure, so this never blocks an extraction.
  // Tokens added: ≤2000 chars (~500 Haiku input tokens) capped by
  // exemplarsToPromptBlock, in exchange for acceptance-rate lift.
  const exemplars = await getAcceptedExemplars({
    clientSlug,
    limit: 3,
    userId,
    userRole,
  });
  const exemplarBlock = exemplarsToPromptBlock(exemplars);
  const systemPrompt = exemplarBlock
    ? `${SYSTEM_PROMPT}\n\n${exemplarBlock}`
    : SYSTEM_PROMPT;

  const t0 = Date.now();
  let aiResult: VisionCallResult | null;
  try {
    aiResult = await ai({
      systemPrompt,
      userText,
      frames: contentBlocks,
      // Back-compat single-frame fields — first block.
      mediaType: contentBlocks[0].mediaType,
      base64Data: contentBlocks[0].base64Data,
    });
  } catch (err) {
    if (err instanceof BriefFromImageNotConfiguredError) {
      trackEvent("site.brief_generation_failed", userId, userRole, {
        generation_id: generationId,
        reason: "ai_not_configured",
        latency_ms: Date.now() - t0,
        frame_count: frames.length,
        source_kind: sourceKind,
      });
      throw err;
    }
    aiResult = null;
  }
  const latencyMs = Date.now() - t0;

  if (!aiResult) {
    trackEvent("site.brief_generation_failed", userId, userRole, {
      generation_id: generationId,
      reason: "ai_unavailable",
      latency_ms: latencyMs,
      frame_count: frames.length,
      source_kind: sourceKind,
    });
    throw new BriefFromImageAIUnavailableError();
  }

  const metrics: BriefFromImageMetrics = {
    latencyMs,
    tokensIn: aiResult.tokensIn,
    tokensOut: aiResult.tokensOut,
    costCents: computeCostCents(aiResult.tokensIn, aiResult.tokensOut),
    model: aiResult.model || BRIEF_FROM_IMAGE_MODEL,
  };

  /* --- 5. Parse + validate --- */

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFences(aiResult.content));
  } catch {
    trackEvent("site.brief_generation_failed", userId, userRole, {
      generation_id: generationId,
      reason: "bad_ai_output",
      latency_ms: latencyMs,
      frame_count: frames.length,
      source_kind: sourceKind,
    });
    throw new BriefFromImageError(
      "vision returned non-JSON content",
      "bad_ai_output",
    );
  }

  if (!parsed || typeof parsed !== "object") {
    trackEvent("site.brief_generation_failed", userId, userRole, {
      generation_id: generationId,
      reason: "bad_ai_output",
      latency_ms: latencyMs,
      frame_count: frames.length,
      source_kind: sourceKind,
    });
    throw new BriefFromImageError(
      "vision returned non-object JSON",
      "bad_ai_output",
    );
  }

  // Force the provided slug — we never trust the model with identity.
  (parsed as Record<string, unknown>).client = clientSlug;

  // Merge measured palette into the model's theme hints.
  const merged = mergePaletteIntoBrief(parsed as SiteBrief, palette);

  // Validate — if the model produced something structurally invalid we
  // surface a distinct error to the route. We do NOT persist a
  // generation row for invalid briefs — matches the pre-multi-frame
  // contract that the existing test suite pins.
  try {
    validateBrief(merged);
  } catch (err) {
    trackEvent("site.brief_generation_failed", userId, userRole, {
      generation_id: generationId,
      reason: "brief_invalid",
      latency_ms: latencyMs,
      frame_count: frames.length,
      source_kind: sourceKind,
      errors:
        err instanceof BriefValidationError
          ? err.errors.slice(0, 10).join("; ").slice(0, 500)
          : (err as Error).message.slice(0, 500),
    });
    throw new BriefFromImageError(
      `vision produced an invalid brief: ${(err as Error).message}`,
      "brief_invalid",
    );
  }

  const detectedFont = ((): string | null => {
    const theme = (merged.theme ?? {}) as SiteTheme;
    const f = theme.font;
    if (f && typeof f === "object" && typeof f.family === "string") {
      return f.family;
    }
    return null;
  })();

  /* --- 6. Persist generation row --- */

  await insertBriefGeneration({
    id: generationId,
    requestedBy: userId,
    sourceMime,
    sourceSize,
    sourceSha256,
    extractedBrief: merged,
    extractedColors: palette.swatches.length > 0 ? palette.swatches : null,
    detectedFont,
    model: metrics.model,
    latencyMs: metrics.latencyMs,
    tokenCostCents: metrics.costCents,
  });

  const pagesExtracted = merged.pages.length;
  const confidence: "low" | "medium" | "high" =
    palette.swatches.length >= 3 && merged.pages[0]?.sections.length >= 2
      ? "high"
      : merged.pages[0]?.sections.length >= 1
        ? "medium"
        : "low";

  trackEvent("site.brief_generation_succeeded", userId, userRole, {
    generation_id: generationId,
    mime: sourceMime,
    size_bytes: sourceSize,
    section_count: merged.pages.reduce((n, p) => n + p.sections.length, 0),
    // `page_count` preserved for existing dashboards; `pages_extracted`
    // added as the explicit synonym called out in the directive so new
    // dashboards can use either name without schema changes.
    page_count: pagesExtracted,
    pages_extracted: pagesExtracted,
    palette_size: palette.swatches.length,
    latency_ms: metrics.latencyMs,
    tokens_in: metrics.tokensIn,
    tokens_out: metrics.tokensOut,
    cost_cents: metrics.costCents,
    model: metrics.model,
    confidence,
    frame_count: frames.length,
    source_kind: sourceKind,
    // Learning-loop KPI: every succeeded event records whether the
    // extraction was primed with exemplars from this client's past
    // accepted briefs. Comparing accepted-rate across primed vs cold
    // extractions is how we prove the tool is actually improving over
    // time — this is the flywheel metric.
    exemplar_count: exemplars.length,
    exemplars_primed: exemplars.length > 0,
  });

  return {
    generationId,
    brief: merged,
    metrics,
    extractedColors: palette.swatches,
    detectedFont,
    confidence,
  };
}

/* ---------------------- User-text builder ---------------------------- */

/** Build the per-call user text. We deliberately keep the single-image
 * wording byte-identical to the pre-multi-frame version so learning-loop
 * metrics (prompt-version regressions, cost-per-brief) stay comparable
 * across the refactor boundary. */
function buildUserText(
  clientSlug: string,
  frames: BriefFrame[],
  kind: BriefSourceKind,
): string {
  const slugLine = `client_slug (keep as-is): ${clientSlug}`;
  if (kind === "image") {
    return `${slugLine}\nExtract the brief for this wireframe. Return JSON only.`;
  }
  if (kind === "pdf") {
    return (
      `${slugLine}\n` +
      `Extract the brief for this PDF wireframe. Each PAGE of the PDF is a distinct website page — produce one entry in \`pages: []\` per PDF page, in order. Return JSON only.`
    );
  }
  // images_multi
  return (
    `${slugLine}\n` +
    `Extract the brief for these ${frames.length} wireframe images. Each IMAGE is a distinct website page — produce one entry in \`pages: []\` per image, in the order received. Return JSON only.`
  );
}

/* --------------------- Main (single-image entrypoint) ---------------- */

/**
 * Preserved single-image entrypoint. Delegates to `briefFromFrames` so
 * there is one orchestrator on one codepath. Output shape is identical
 * to the pre-refactor contract — existing callers and tests are
 * unchanged.
 */
export async function briefFromImage(
  input: BriefFromImageInput,
): Promise<BriefFromImageResult> {
  return briefFromFrames({
    frames: [{ bytes: input.bytes, mime: input.mime }],
    clientSlug: input.clientSlug,
    userId: input.userId,
    userRole: input.userRole,
    ai: input.ai,
  });
}
