/**
 * brief-from-image — wireframe image/PDF → SiteBrief orchestrator.
 *
 * Flow:
 *   1. Route hands us raw bytes + MIME + user context.
 *   2. We extract a deterministic colour palette with a pure-JS k-means
 *      (see ./image-palette.ts). This ALWAYS runs and never requires
 *      the LLM — the model only needs colour hints when decoding fails.
 *   3. We send the image to Claude's vision API asking for a strict
 *      JSON SiteBrief. Same SDK pattern as brief-edit.ts (raw fetch,
 *      no new deps).
 *   4. We merge the palette into the brief's theme (preferring palette
 *      over model output for consistency — the model guesses, the
 *      palette measures), validate with validateBrief(), and persist
 *      a generation row + analytics event so the brain never loses a
 *      wireframe → brief attempt.
 *
 * Error modes — each is distinct so the route can surface actionable
 * messages rather than "something went wrong":
 *   - BriefFromImageNotConfiguredError  → ANTHROPIC_API_KEY missing
 *   - BriefFromImageAIUnavailableError  → model call failed / timed out
 *   - BriefFromImageError               → malformed or invalid output
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

/* -------------------------------- Types ------------------------------- */

export interface BriefFromImageInput {
  bytes: Uint8Array;
  mime: string;
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

/* ------------------------------- Errors ------------------------------- */

export class BriefFromImageError extends Error {
  constructor(
    message: string,
    public reason: "bad_ai_output" | "brief_invalid" | "unsupported_mime",
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

export interface VisionCallInput {
  systemPrompt: string;
  userText: string;
  mediaType: string;
  base64Data: string;
}

export type VisionCaller = (
  input: VisionCallInput,
) => Promise<VisionCallResult | null>;

/**
 * Default vision caller: raw fetch to Claude Messages API with the
 * `image` content block. Mirrors the patter in brief-edit.ts so ops
 * only has to trust one codepath to Anthropic.
 */
export const defaultVisionCaller: VisionCaller = async ({
  systemPrompt,
  userText,
  mediaType,
  base64Data,
}) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new BriefFromImageNotConfiguredError();
  try {
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
        messages: [
          {
            role: "user",
            content: [
              {
                type: mediaType === "application/pdf" ? "document" : "image",
                source: {
                  type: "base64",
                  media_type: mediaType,
                  data: base64Data,
                },
              },
              { type: "text", text: userText },
            ],
          },
        ],
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
- Output ONLY valid JSON, no markdown fences, no commentary.`;

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

/* ------------------------------- Main --------------------------------- */

export async function briefFromImage(
  input: BriefFromImageInput,
): Promise<BriefFromImageResult> {
  const { bytes, mime, clientSlug, userId, userRole } = input;
  const ai = input.ai ?? defaultVisionCaller;
  const generationId = `site_brief_gen_${randomUUID()}`;

  if (!SUPPORTED_IMAGE_MIMES.has(mime)) {
    trackEvent("site.brief_image_rejected", userId, userRole, {
      reason: "unsupported_mime",
      mime,
      size_bytes: bytes.byteLength,
    });
    throw new BriefFromImageError(
      `unsupported MIME type "${mime}"`,
      "unsupported_mime",
    );
  }

  const sha256 = sha256Hex(bytes);

  trackEvent("site.brief_generation_requested", userId, userRole, {
    generation_id: generationId,
    mime,
    size_bytes: bytes.byteLength,
    sha256,
  });

  // Palette extraction runs regardless of model success so the learning
  // loop + dashboards still get colour data on failure paths.
  const palette = extractPalette(bytes);

  const t0 = Date.now();
  let aiResult: VisionCallResult | null;
  try {
    aiResult = await ai({
      systemPrompt: SYSTEM_PROMPT,
      userText: `client_slug (keep as-is): ${clientSlug}\nExtract the brief for this wireframe. Return JSON only.`,
      mediaType: mime,
      base64Data: bytesToBase64(bytes),
    });
  } catch (err) {
    if (err instanceof BriefFromImageNotConfiguredError) {
      trackEvent("site.brief_generation_failed", userId, userRole, {
        generation_id: generationId,
        reason: "ai_not_configured",
        latency_ms: Date.now() - t0,
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

  // Parse
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFences(aiResult.content));
  } catch {
    trackEvent("site.brief_generation_failed", userId, userRole, {
      generation_id: generationId,
      reason: "bad_ai_output",
      latency_ms: latencyMs,
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
  // still persist the generation row so the brain learns what "bad
  // output" looks like, then surface a distinct error to the route.
  try {
    validateBrief(merged);
  } catch (err) {
    trackEvent("site.brief_generation_failed", userId, userRole, {
      generation_id: generationId,
      reason: "brief_invalid",
      latency_ms: latencyMs,
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

  // Persist the generation — accepted=NULL until user commits/discards.
  // safeQuery swallows DB errors in shadow mode so this is safe to await.
  await insertBriefGeneration({
    id: generationId,
    requestedBy: userId,
    sourceMime: mime,
    sourceSize: bytes.byteLength,
    sourceSha256: sha256,
    extractedBrief: merged,
    extractedColors: palette.swatches.length > 0 ? palette.swatches : null,
    detectedFont,
    model: metrics.model,
    latencyMs: metrics.latencyMs,
    tokenCostCents: metrics.costCents,
  });

  const confidence: "low" | "medium" | "high" =
    palette.swatches.length >= 3 && merged.pages[0]?.sections.length >= 2
      ? "high"
      : merged.pages[0]?.sections.length >= 1
        ? "medium"
        : "low";

  trackEvent("site.brief_generation_succeeded", userId, userRole, {
    generation_id: generationId,
    mime,
    size_bytes: bytes.byteLength,
    section_count: merged.pages.reduce((n, p) => n + p.sections.length, 0),
    page_count: merged.pages.length,
    palette_size: palette.swatches.length,
    latency_ms: metrics.latencyMs,
    tokens_in: metrics.tokensIn,
    tokens_out: metrics.tokensOut,
    cost_cents: metrics.costCents,
    model: metrics.model,
    confidence,
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
