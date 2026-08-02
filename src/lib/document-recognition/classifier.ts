/**
 * Document Recognition — classifier.
 *
 * Input: raw bytes + MIME for a single upload (image OR PDF).
 * Output: DocumentClassification — best-guess docType, up to 3 alternates,
 * rationale, latency, and computed cost in USD cents.
 *
 * Pattern mirrors src/lib/brief-from-image.ts so ops only has to trust one
 * codepath into Anthropic:
 *   - ANTHROPIC_API_KEY check at the edge → ClassifierNotConfiguredError
 *   - VisionCaller injection for tests; default uses raw fetch to
 *     https://api.anthropic.com/v1/messages (no SDK runtime dependency
 *     beyond what brief-from-image already exercises)
 *   - claude-haiku-4-5-20251001 model id pinned at top of file
 *   - HAIKU_INPUT_USD_PER_MTOK / HAIKU_OUTPUT_USD_PER_MTOK constants match
 *     brief-from-image so cost dashboards stay coherent
 *   - PDFs sent as `document` block, images as `image` block (same as
 *     brief-from-image)
 *
 * Output is strict-validated before return — type must be in the
 * DocumentType enum, confidence must be in [0,1], rationale <= 240 chars,
 * alternates must be well-formed and are sorted descending by confidence
 * defensively in case the model returned them out of order.
 *
 * PII pre-scan is NOT handled here — Stream C runs it before calling us.
 * This module is pure classification; it never persists or logs PII.
 */

import {
  DOCUMENT_TYPES,
  SUPPORTED_MIMES,
  type ClassifierCandidate,
  type DocumentClassification,
  type DocumentType,
} from "./types";

import { renderPrompt } from "@/lib/prompts/registry";
import { DOCUMENT_CLASSIFY } from "@/lib/prompts/definitions/documents";
/* ------------------------------ Constants ----------------------------- */

/** Pinned model id. Matches brief-from-image.ts so the cost-usd calc and
 * migration tests stay aligned when we bump it. Vision-capable Haiku. */
export const CLASSIFIER_MODEL = "claude-haiku-4-5-20251001";

// Same list-price numbers brief-from-image.ts uses. USD per 1M tokens.
const HAIKU_INPUT_USD_PER_MTOK = 1.0;
const HAIKU_OUTPUT_USD_PER_MTOK = 5.0;

const PDF_MIME = "application/pdf";

/** Maximum rationale length the model is allowed to return. Mirrors the
 * cap declared in types.ts comments on DocumentClassification.rationale. */
const MAX_RATIONALE_CHARS = 240;

/** Maximum alternates we accept. types.ts says "up to 3". */
const MAX_ALTERNATES = 3;

/* -------------------------------- Errors ------------------------------- */

export class ClassifierNotConfiguredError extends Error {
  constructor(message = "ANTHROPIC_API_KEY is not set — classifier disabled") {
    super(message);
    this.name = "ClassifierNotConfiguredError";
  }
}

export class ClassifierAIUnavailableError extends Error {
  constructor(message = "classifier vision call returned no usable response") {
    super(message);
    this.name = "ClassifierAIUnavailableError";
  }
}

export class ClassifierMalformedOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClassifierMalformedOutputError";
  }
}

/** Thrown synchronously for unsupported MIMEs — caller-level guard rail. */
export class ClassifierUnsupportedMimeError extends Error {
  constructor(mime: string) {
    super(`unsupported MIME type "${mime}"`);
    this.name = "ClassifierUnsupportedMimeError";
  }
}

/* ----------------------------- Vision caller -------------------------- */

export interface VisionCallResult {
  content: string;
  tokensIn: number;
  tokensOut: number;
  model: string;
}

export interface VisionContentBlock {
  kind: "image" | "document";
  mediaType: string;
  base64Data: string;
}

export interface VisionCallInput {
  systemPrompt: string;
  userText: string;
  block: VisionContentBlock;
}

export type VisionCaller = (
  input: VisionCallInput,
) => Promise<VisionCallResult | null>;

/**
 * Default vision caller — raw fetch to the Messages API. Mirrors the
 * pattern in brief-from-image.ts so ops only has to trust one codepath.
 * Throws ClassifierNotConfiguredError if the API key is missing so the
 * orchestrator can surface a distinct, actionable error.
 */
export const defaultVisionCaller: VisionCaller = async ({
  systemPrompt,
  userText,
  block,
}) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new ClassifierNotConfiguredError();
  try {
    const content: Array<Record<string, unknown>> = [
      {
        type: block.kind,
        source: {
          type: "base64",
          media_type: block.mediaType,
          data: block.base64Data,
        },
      },
      { type: "text", text: userText },
    ];

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: CLASSIFIER_MODEL,
        max_tokens: 1024,
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
      model: (data.model as string) ?? CLASSIFIER_MODEL,
    };
  } catch {
    return null;
  }
};

/* ----------------------------- System prompt -------------------------- */

/** Registered as document.classify. Moved to src/lib/prompts so it has an id
 *  an eval can score and a declared scope; the text is unchanged. */
const SYSTEM_PROMPT = renderPrompt(DOCUMENT_CLASSIFY, {});

const USER_TEXT =
  "Classify this document. Return only JSON matching DocumentClassification.";

/* ------------------------------- Helpers ------------------------------- */

function stripJsonFences(raw: string): string {
  return raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
}

function computeCostCents(tokensIn: number, tokensOut: number): number {
  const usd =
    (tokensIn / 1_000_000) * HAIKU_INPUT_USD_PER_MTOK +
    (tokensOut / 1_000_000) * HAIKU_OUTPUT_USD_PER_MTOK;
  return Math.round(usd * 100);
}

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function isDocumentType(v: unknown): v is DocumentType {
  return typeof v === "string" && (DOCUMENT_TYPES as readonly string[]).includes(v);
}

function isConfidence(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
}

/** Strict structural validation. Throws ClassifierMalformedOutputError
 * with a precise reason so the orchestrator can log + surface it. */
function validateClassification(raw: unknown): {
  type: DocumentType;
  confidence: number;
  alternates: ClassifierCandidate[];
  rationale: string;
} {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ClassifierMalformedOutputError(
      "classifier output is not a JSON object",
    );
  }
  const obj = raw as Record<string, unknown>;

  if (!isDocumentType(obj.type)) {
    throw new ClassifierMalformedOutputError(
      `classifier returned invalid type: ${JSON.stringify(obj.type)}`,
    );
  }
  if (!isConfidence(obj.confidence)) {
    throw new ClassifierMalformedOutputError(
      `classifier returned invalid confidence: ${JSON.stringify(obj.confidence)}`,
    );
  }
  if (typeof obj.rationale !== "string") {
    throw new ClassifierMalformedOutputError(
      "classifier rationale must be a string",
    );
  }
  if (obj.rationale.length > MAX_RATIONALE_CHARS) {
    throw new ClassifierMalformedOutputError(
      `classifier rationale exceeds ${MAX_RATIONALE_CHARS} chars (got ${obj.rationale.length})`,
    );
  }
  if (!Array.isArray(obj.alternates)) {
    throw new ClassifierMalformedOutputError(
      "classifier alternates must be an array",
    );
  }
  if (obj.alternates.length > MAX_ALTERNATES) {
    throw new ClassifierMalformedOutputError(
      `classifier returned more than ${MAX_ALTERNATES} alternates`,
    );
  }

  const alternates: ClassifierCandidate[] = [];
  for (const [idx, candidateRaw] of obj.alternates.entries()) {
    if (!candidateRaw || typeof candidateRaw !== "object") {
      throw new ClassifierMalformedOutputError(
        `alternate at index ${idx} is not an object`,
      );
    }
    const c = candidateRaw as Record<string, unknown>;
    if (!isDocumentType(c.type)) {
      throw new ClassifierMalformedOutputError(
        `alternate at index ${idx} has invalid type: ${JSON.stringify(c.type)}`,
      );
    }
    if (!isConfidence(c.confidence)) {
      throw new ClassifierMalformedOutputError(
        `alternate at index ${idx} has invalid confidence: ${JSON.stringify(c.confidence)}`,
      );
    }
    if (c.type === obj.type) {
      throw new ClassifierMalformedOutputError(
        `alternate at index ${idx} repeats top-pick type "${obj.type}"`,
      );
    }
    alternates.push({ type: c.type, confidence: c.confidence });
  }

  // Defensive sort — even if the model returned alternates out of order
  // we present them descending by confidence to downstream code.
  alternates.sort((a, b) => b.confidence - a.confidence);

  return {
    type: obj.type,
    confidence: obj.confidence,
    alternates,
    rationale: obj.rationale,
  };
}

/* ------------------------------- Public API --------------------------- */

export interface ClassifyInput {
  bytes: Uint8Array;
  mime: string;
  /** Optional injection for tests. Default uses defaultVisionCaller. */
  ai?: VisionCaller;
}

/**
 * Classify a document. Returns a DocumentClassification matching the
 * shape declared in types.ts.
 *
 * Errors:
 *  - ClassifierUnsupportedMimeError  — MIME is not in SUPPORTED_MIMES
 *  - ClassifierNotConfiguredError    — ANTHROPIC_API_KEY missing
 *  - ClassifierAIUnavailableError    — model call returned null / threw
 *  - ClassifierMalformedOutputError  — model output failed validation
 */
export async function classifyDocument(
  input: ClassifyInput,
): Promise<DocumentClassification> {
  const { bytes, mime } = input;

  if (!SUPPORTED_MIMES.has(mime)) {
    throw new ClassifierUnsupportedMimeError(mime);
  }

  const ai = input.ai ?? defaultVisionCaller;

  const block: VisionContentBlock = {
    kind: mime === PDF_MIME ? "document" : "image",
    mediaType: mime,
    base64Data: bytesToBase64(bytes),
  };

  const t0 = Date.now();
  let aiResult: VisionCallResult | null;
  try {
    aiResult = await ai({
      systemPrompt: SYSTEM_PROMPT,
      userText: USER_TEXT,
      block,
    });
  } catch (err) {
    if (err instanceof ClassifierNotConfiguredError) throw err;
    aiResult = null;
  }
  const latencyMs = Date.now() - t0;

  if (!aiResult) {
    throw new ClassifierAIUnavailableError();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFences(aiResult.content));
  } catch {
    throw new ClassifierMalformedOutputError(
      "classifier returned non-JSON content",
    );
  }

  const validated = validateClassification(parsed);

  const costCents = computeCostCents(aiResult.tokensIn, aiResult.tokensOut);

  return {
    type: validated.type,
    confidence: validated.confidence,
    alternates: validated.alternates,
    rationale: validated.rationale,
    model: aiResult.model || CLASSIFIER_MODEL,
    latencyMs,
    costCents,
  };
}
