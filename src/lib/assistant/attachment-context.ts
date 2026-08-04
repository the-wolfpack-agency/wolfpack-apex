/**
 * Turn the files attached to THIS message into grounding the assistant can read.
 *
 * WHY THIS EXISTS
 *
 * Attaching a screenshot and asking "look at the screen shot" produced "I cannot
 * view screenshots or attachments directly." That reply was accurate about what
 * the code did, and wrong about what the product can do: `ocrImage()` in
 * `src/lib/azure/vision-ocr.ts` has been reading screenshots for the brain
 * ingest path all along.
 *
 * The attachment never reached the model. `fileContents` arrived at
 * `/api/assistant` complete with the image's base64, and was used for exactly
 * two things: the document quality gate and an analytics event. Nothing passed
 * it to `chat()`.
 *
 * What DID happen is subtler and is why the failure looked so strange. Attached
 * files are ingested into the Central Brain and become searchable, so the turn
 * fell through to ordinary retrieval — which answered the question using three
 * OLDER screenshots from May and June. The file the user was pointing at was
 * the one thing not consulted.
 *
 * So the fix is not "add vision". It is: the file in front of the user is
 * grounding for the turn they are in, not just a document for later search.
 *
 * WHAT THIS DOES
 *
 *   image/*        → Azure Computer Vision READ (`ocrImage`), the same call the
 *                    brain ingest path uses. Screenshots are text-bearing, so
 *                    OCR is the right read for them.
 *   text-like      → used directly, truncated.
 *   anything else  → named honestly as unreadable, so the assistant can say
 *                    which file it could not open instead of claiming it cannot
 *                    open anything.
 *
 * Every outcome emits an analytics event, including the failures — a file the
 * assistant could not read is exactly the signal that says which formats to
 * support next.
 */
import { ocrImage, isVisionConfigured, VISION_MAX_BYTES } from "@/lib/azure/vision-ocr";
import { trackEvent } from "@/lib/analytics";

/** Per-file cap on extracted text folded into the prompt. Generous enough for
 *  a dense screenshot, small enough that several attachments cannot crowd out
 *  the conversation. */
export const MAX_CHARS_PER_ATTACHMENT = 4000;

/** Cap across all attachments in one turn. */
export const MAX_CHARS_TOTAL = 12000;

export interface AttachmentInput {
  name: string;
  /** MIME type as reported by the browser. May be absent or wrong. */
  type?: string;
  /** Either a `data:` URL (binary, as the chat client encodes it) or raw text. */
  content: string;
}

export type AttachmentReadStatus =
  | "text"
  | "ocr"
  | "ocr_empty"
  | "too_large"
  | "not_configured"
  | "ocr_failed"
  | "unsupported"
  | "empty";

export interface AttachmentRead {
  name: string;
  status: AttachmentReadStatus;
  /** Extracted text. Empty when the file could not be read. */
  text: string;
  /** Human-readable reason, present only when `text` is empty. */
  detail?: string;
}

export interface AttachmentContext {
  reads: AttachmentRead[];
  /** The prompt block, or "" when there is nothing worth sending. */
  block: string;
  /** True when at least one attachment produced usable text. */
  hasContent: boolean;
}

/** Split a `data:<mime>;base64,<payload>` URL. Returns null for anything else. */
export function parseDataUrl(
  content: string,
): { mime: string; bytes: Buffer } | null {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(content);
  if (!m) return null;
  const mime = m[1] || "application/octet-stream";
  const isBase64 = Boolean(m[2]);
  const payload = m[3] ?? "";
  try {
    const bytes = isBase64
      ? Buffer.from(payload, "base64")
      : Buffer.from(decodeURIComponent(payload), "utf8");
    return { mime, bytes };
  } catch {
    return null;
  }
}

function isImageMime(mime: string): boolean {
  return /^image\//i.test(mime);
}

/** Read one attachment. Never throws: a file we cannot read is a reportable
 *  outcome, not an error that should take down the user's whole turn. */
async function readOne(
  file: AttachmentInput,
  opts: { userId: string; userRole: string },
): Promise<AttachmentRead> {
  const declared = (file.type ?? "").toLowerCase();
  const parsed = parseDataUrl(file.content);
  /* Trust the data URL's own MIME over the browser's `type`: drag-and-drop from
     some apps reports "" or "application/octet-stream" for a PNG. */
  const mime = parsed?.mime?.toLowerCase() || declared;

  /* Plain text arrived as text — no decoding needed. */
  if (!parsed) {
    const text = file.content.trim();
    if (!text) {
      return { name: file.name, status: "empty", text: "", detail: "the file was empty" };
    }
    return {
      name: file.name,
      status: "text",
      text: text.slice(0, MAX_CHARS_PER_ATTACHMENT),
    };
  }

  if (!isImageMime(mime)) {
    /* A decodable non-image (PDF, DOCX) still lands in the brain via the
       ingest path, so say so rather than implying it vanished. */
    return {
      name: file.name,
      status: "unsupported",
      text: "",
      detail: `${mime || "this file type"} cannot be read inline yet; it has been added to the knowledge base and is searchable`,
    };
  }

  if (parsed.bytes.length > VISION_MAX_BYTES) {
    return {
      name: file.name,
      status: "too_large",
      text: "",
      detail: `the image is ${(parsed.bytes.length / 1024 / 1024).toFixed(1)} MB, above the ${(VISION_MAX_BYTES / 1024 / 1024).toFixed(1)} MB limit for reading images`,
    };
  }

  if (!isVisionConfigured()) {
    return {
      name: file.name,
      status: "not_configured",
      text: "",
      detail: "image reading is not configured on this deployment",
    };
  }

  const result = await ocrImage(parsed.bytes, {
    triggeredBy: opts.userId,
    triggeredByRole: opts.userRole,
    contentType: mime,
  });

  if (!result.ok) {
    return {
      name: file.name,
      status: "ocr_failed",
      text: "",
      detail: result.detail || result.reason,
    };
  }

  const text = (result.text ?? "").trim();
  if (!text) {
    /* A real outcome, not a failure: a photo with no text in it. Saying so is
       more useful than silence, because it tells the user why the answer is
       thin. */
    return {
      name: file.name,
      status: "ocr_empty",
      text: "",
      detail: "no readable text was found in the image",
    };
  }

  return {
    name: file.name,
    status: "ocr",
    text: text.slice(0, MAX_CHARS_PER_ATTACHMENT),
  };
}

/**
 * Read every attachment on this turn and render the prompt block.
 *
 * Reads run concurrently: each is a separate network call to Azure, and a user
 * attaching four screenshots should not wait four round-trips.
 */
export async function buildAttachmentContext(
  files: AttachmentInput[] | undefined,
  opts: { userId: string; userRole: string },
): Promise<AttachmentContext> {
  if (!files || files.length === 0) {
    return { reads: [], block: "", hasContent: false };
  }

  const reads = await Promise.all(files.map((f) => readOne(f, opts)));

  for (const r of reads) {
    trackEvent("assistant.attachment_read", opts.userId, opts.userRole, {
      file_name: r.name,
      status: r.status,
      chars: r.text.length,
      module: "assistant",
    });
  }

  const lines: string[] = [];
  let budget = MAX_CHARS_TOTAL;

  for (const r of reads) {
    if (r.text) {
      const slice = r.text.slice(0, Math.max(0, budget));
      budget -= slice.length;
      if (!slice) continue;
      lines.push(`--- Attachment: "${r.name}" ---\n${slice}`);
    } else {
      lines.push(`--- Attachment: "${r.name}" — could not be read: ${r.detail} ---`);
    }
  }

  const hasContent = reads.some((r) => r.text.length > 0);

  if (lines.length === 0) return { reads, block: "", hasContent: false };

  const header = hasContent
    ? [
        "The user attached the following file(s) to THIS message. This is the",
        "content they are asking about — treat it as the primary source and",
        "answer from it directly. Do not say you cannot view attachments: the",
        "text below was extracted from them for you. For images, the text was",
        "read by OCR, so minor character errors are possible.",
      ].join("\n")
    : [
        "The user attached file(s) to THIS message, but none could be read.",
        "Tell them plainly which file failed and why, using the reason given",
        "below. Do not claim you are unable to view attachments in general.",
      ].join("\n");

  return {
    reads,
    block: [header, "", ...lines].join("\n"),
    hasContent,
  };
}
