/**
 * POST /api/documents/recognize — generic document recognition pipeline.
 *
 *   1. Auth + workspace scoping (requireCapability).
 *   2. Multipart parse + MIME/size/empty validation.
 *   3. PII pre-scan (defense in depth before any vendor call).
 *   4. SHA-256 hash + 24h dedup (no double vendor charges).
 *   5. Classifier (vision LLM) — sets DocumentType + confidence.
 *   6. Router-driven extractor (Azure prebuilt or none).
 *   7. Persist row to instinct_document_recognitions — every outcome,
 *      success or failure, lands in the table so the learning loop
 *      sees the full distribution.
 *   8. trackEvent (cascades to triple-write automatically).
 *
 * Env gate: DOCUMENT_RECOGNITION_ENABLED must be "true". Off by default
 * so the route never silently spends money in environments that haven't
 * configured the upstream vendors.
 *
 * Capability: tools.run. The endpoint is a tool surface, not an HR /
 * finance vertical — those verticals consume the output via the
 * dedicated /api/hr/* and /api/finance/* routes.
 */

import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import { preScanForBlockingPII } from "@/lib/azure/pre-scan";
import { classifyDocument } from "@/lib/document-recognition/classifier";
import { extractDocument } from "@/lib/document-recognition/router";
import {
  insertRecognition,
  findRecentBySha,
  getRecognition,
} from "@/lib/document-recognition/persistence";
import {
  MAX_DOCUMENT_BYTES,
  SUPPORTED_MIMES,
  type DocumentClassification,
  type ExtractedDocument,
  type RecognizedDocument,
} from "@/lib/document-recognition/types";

const DEDUP_WINDOW_HOURS = 24;

function featureEnabled(): boolean {
  const v = (process.env.DOCUMENT_RECOGNITION_ENABLED ?? "").toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}

/** Shape returned to the client. Mirrors RecognizedDocument and adds
 *  the from_cache + warning flags. */
interface RecognizeResponseBody {
  ok: boolean;
  from_cache: boolean;
  piiBlocked: boolean;
  recognition: RecognizedDocument;
  warning?: string;
}

export async function POST(req: NextRequest) {
  /* Feature flag — keep first so unconfigured envs don't even pretend
     to attempt auth + parse + Azure. */
  if (!featureEnabled()) {
    return NextResponse.json({ error: "feature_disabled" }, { status: 503 });
  }

  const auth = await requireCapability(req, "tools.run");
  if (!auth.ok) return auth.response;

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "invalid multipart body" }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "file is required" }, { status: 400 });
  }

  const mime = (file.type || "").toLowerCase();
  if (!SUPPORTED_MIMES.has(mime)) {
    return NextResponse.json(
      { error: "unsupported_mime", detail: mime || "unknown" },
      { status: 415 },
    );
  }
  if (file.size === 0) {
    return NextResponse.json({ error: "empty_file" }, { status: 400 });
  }
  if (file.size > MAX_DOCUMENT_BYTES) {
    return NextResponse.json(
      { error: "oversize", max_bytes: MAX_DOCUMENT_BYTES },
      { status: 413 },
    );
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  /* Dedup window — same workspace + same SHA in the last 24h returns
     the cached recognition. Saves an Anthropic call + an Azure call. */
  const cached = await findRecentBySha(auth.user.workspaceId, sha256, DEDUP_WINDOW_HOURS);
  if (cached) {
    trackEvent("system.document_recognized", auth.user.id, auth.user.role, {
      recognition_id: cached.id,
      classified_type: cached.classification.type,
      classification_confidence: cached.classification.confidence,
      extractor_key: cached.extraction?.extractor ?? "none",
      success: cached.extraction !== null,
      pii_blocked: cached.piiBlocked,
      classifier_latency_ms: cached.classification.latencyMs,
      extractor_latency_ms: cached.extraction?.latencyMs ?? 0,
      total_cost_cents: 0,
      cached: true,
    });
    return NextResponse.json({
      ok: true,
      from_cache: true,
      piiBlocked: cached.piiBlocked,
      recognition: cached,
    } satisfies RecognizeResponseBody);
  }

  /* PII pre-scan — refuse high-confidence secrets / SSN / cards
     before any vendor call. When blocked we still persist a row so
     the learning loop sees the rejection rate. */
  const pre = preScanForBlockingPII(bytes);
  if (!pre.ok) {
    const fallbackClassification: DocumentClassification = {
      type: "unknown",
      confidence: 0,
      alternates: [],
      rationale: "pre-scan blocked vendor call",
      model: "none",
      latencyMs: 0,
      costCents: 0,
    };
    const { id } = await insertRecognition({
      workspaceId: auth.user.workspaceId,
      uploadedBy: auth.user.id,
      source: { filename: file.name, mime, bytes: bytes.length, sha256 },
      classification: fallbackClassification,
      extraction: null,
      piiBlocked: true,
      errorKind: "pii_blocked",
      errorMessage: `blocked_by=${pre.blockedBy.join(",")}`,
    });
    trackEvent("system.document_recognized", auth.user.id, auth.user.role, {
      recognition_id: id,
      classified_type: "unknown",
      classification_confidence: 0,
      extractor_key: "none",
      success: false,
      pii_blocked: true,
      classifier_latency_ms: 0,
      extractor_latency_ms: 0,
      total_cost_cents: 0,
      error_kind: "pii_blocked",
    });
    const recognition = await getRecognition(auth.user.workspaceId, id);
    return NextResponse.json({
      ok: true,
      from_cache: false,
      piiBlocked: true,
      recognition: recognition ?? {
        id,
        workspaceId: auth.user.workspaceId,
        userId: auth.user.id,
        sourceFile: { filename: file.name, mime, bytes: bytes.length, sha256 },
        classification: fallbackClassification,
        extraction: null,
        piiBlocked: true,
        recognizedAt: new Date().toISOString(),
      },
    } satisfies RecognizeResponseBody);
  }

  /* Classifier — vision LLM. Failure persists a row with error_kind +
     returns a 502 because we genuinely don't know the type. */
  let classification: DocumentClassification;
  try {
    classification = await classifyDocument({ bytes, mime });
  } catch (err) {
    const msg = (err as Error).message;
    const errKind = "classifier_failed";
    const fallbackClassification: DocumentClassification = {
      type: "unknown",
      confidence: 0,
      alternates: [],
      rationale: "classifier threw",
      model: "none",
      latencyMs: 0,
      costCents: 0,
    };
    const { id } = await insertRecognition({
      workspaceId: auth.user.workspaceId,
      uploadedBy: auth.user.id,
      source: { filename: file.name, mime, bytes: bytes.length, sha256 },
      classification: fallbackClassification,
      extraction: null,
      piiBlocked: false,
      errorKind: errKind,
      errorMessage: msg,
    });
    trackEvent("system.document_recognized", auth.user.id, auth.user.role, {
      recognition_id: id,
      classified_type: "unknown",
      classification_confidence: 0,
      extractor_key: "none",
      success: false,
      pii_blocked: false,
      classifier_latency_ms: 0,
      extractor_latency_ms: 0,
      total_cost_cents: 0,
      error_kind: errKind,
    });
    return NextResponse.json(
      { error: errKind, detail: msg, recognition_id: id },
      { status: 502 },
    );
  }

  /* Extractor — may return null for type=unknown. May throw on a real
     vendor error; we persist the classifier output anyway and surface
     a 200 + warning so the user still sees the classification. */
  let extraction: ExtractedDocument | null = null;
  let extractorErrorKind: string | undefined;
  let extractorErrorMessage: string | undefined;
  if (classification.type !== "unknown") {
    try {
      extraction = await extractDocument({
        bytes,
        mime,
        classification,
        audit: {
          triggeredBy: auth.user.id,
          triggeredByRole: auth.user.role,
          /* documentId is unset pre-persist; the extractor logs the
             recognition_id via the trackEvent metadata after insert. */
          documentId: undefined,
        },
      });
    } catch (err) {
      extractorErrorKind = "extractor_failed";
      extractorErrorMessage = (err as Error).message;
    }
  }

  const { id } = await insertRecognition({
    workspaceId: auth.user.workspaceId,
    uploadedBy: auth.user.id,
    source: { filename: file.name, mime, bytes: bytes.length, sha256 },
    classification,
    extraction,
    piiBlocked: false,
    errorKind: extractorErrorKind,
    errorMessage: extractorErrorMessage,
  });

  trackEvent("system.document_recognized", auth.user.id, auth.user.role, {
    recognition_id: id,
    classified_type: classification.type,
    classification_confidence: classification.confidence,
    extractor_key: extraction?.extractor ?? "none",
    success: extraction !== null,
    pii_blocked: false,
    classifier_latency_ms: classification.latencyMs,
    extractor_latency_ms: extraction?.latencyMs ?? 0,
    total_cost_cents:
      (classification.costCents ?? 0) + (extraction?.costCents ?? 0),
    ...(extractorErrorKind ? { error_kind: extractorErrorKind } : {}),
  });

  /* Re-read so the response reflects the persisted row's id +
     recognizedAt + the canonical mapper output. Falls back to an
     in-memory shape if the re-read returns null (shouldn't happen). */
  const persisted = await getRecognition(auth.user.workspaceId, id);
  const recognition: RecognizedDocument = persisted ?? {
    id,
    workspaceId: auth.user.workspaceId,
    userId: auth.user.id,
    sourceFile: { filename: file.name, mime, bytes: bytes.length, sha256 },
    classification,
    extraction,
    piiBlocked: false,
    recognizedAt: new Date().toISOString(),
  };

  const body: RecognizeResponseBody = {
    ok: true,
    from_cache: false,
    piiBlocked: false,
    recognition,
  };
  if (extractorErrorKind) {
    body.warning = `extractor_failed: ${extractorErrorMessage ?? "unknown"}`;
  }
  return NextResponse.json(body);
}
