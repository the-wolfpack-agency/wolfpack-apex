/**
 * chat-ingest.ts — drop-a-file-into-Assistant-and-it-becomes-searchable.
 *
 * The Assistant chat surface already accepts file drags (InstinctChat.tsx
 * has the drag/drop + file input plumbing). Historically those files
 * were inlined into the chat message as one-shot context — useful for
 * "summarize this PDF" style asks, but they vanished after the turn.
 *
 * This helper POSTs the same file to /api/brain/ingest in parallel
 * with the chat send so the dropped doc is permanently indexed into
 * the Central Brain. The next question — by anyone in the org —
 * surfaces it via the existing brain RAG retrieval, with proper
 * citations, audit, dedupe, and rate limiting (all handled inside the
 * /api/brain/ingest endpoint already).
 *
 * Failures are non-fatal: if ingest fails (rate limit, oversized,
 * unsupported MIME), the chat send still proceeds; we just surface a
 * UX-friendly system message in the thread so the user knows the
 * dropped file didn't land in long-term storage.
 */

import { fetchWithRefresh } from "@/lib/client-auth";

export interface IngestSuccess {
  ok: true;
  documentId: string;
  chunkCount: number;
  extractedChars: number;
  duplicateOf?: string;
}

export interface IngestFailure {
  ok: false;
  status: number;
  code:
    | "rate_limited"
    | "unauthorized"
    | "validation"
    | "unsupported"
    | "network"
    | "internal";
  message: string;
  retryAfterSec?: number;
}

export type IngestResult = IngestSuccess | IngestFailure;

/**
 * POST a File blob to /api/brain/ingest and return a structured result.
 * Never throws; failures are returned as `IngestFailure` so callers can
 * surface them in the chat thread without a UI crash.
 */
export async function ingestFileFromChat(file: File): Promise<IngestResult> {
  const form = new FormData();
  form.append("file", file, file.name);
  let res: Response;
  try {
    res = await fetchWithRefresh("/api/brain/ingest", {
      method: "POST",
      body: form,
    });
  } catch (err) {
    return {
      ok: false,
      status: 0,
      code: "network",
      message: `network error: ${(err as Error)?.message ?? "unknown"}`,
    };
  }

  if (res.status === 401) {
    return { ok: false, status: 401, code: "unauthorized", message: "Session expired — sign in to add to knowledge." };
  }
  if (res.status === 429) {
    const retryRaw = res.headers.get("retry-after");
    const retryAfterSec = retryRaw ? Number(retryRaw) : undefined;
    return {
      ok: false,
      status: 429,
      code: "rate_limited",
      message: "Too many uploads in a row — try again in a minute.",
      retryAfterSec: Number.isFinite(retryAfterSec) ? retryAfterSec : undefined,
    };
  }
  if (res.status === 400 || res.status === 415) {
    return {
      ok: false,
      status: res.status,
      code: res.status === 415 ? "unsupported" : "validation",
      message: await safeReadError(res, "File rejected by the ingest endpoint."),
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      code: "internal",
      message: await safeReadError(res, `Ingest failed (HTTP ${res.status}).`),
    };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return {
      ok: false,
      status: res.status,
      code: "internal",
      message: "Ingest succeeded but the response was not JSON.",
    };
  }
  const b = body as Record<string, unknown>;
  if (typeof b?.document_id !== "string") {
    return {
      ok: false,
      status: res.status,
      code: "internal",
      message: "Ingest response missing document_id.",
    };
  }
  return {
    ok: true,
    documentId: b.document_id as string,
    chunkCount: Number(b.chunk_count ?? 0) || 0,
    extractedChars: Number(b.extracted_chars ?? 0) || 0,
    duplicateOf:
      typeof b.duplicate_of === "string" ? (b.duplicate_of as string) : undefined,
  };
}

/**
 * Format an ingest result as a user-facing system message for the chat
 * thread. Markdown — Instinct's chat renderer already handles links +
 * bold. Each variant includes a /knowledge?doc=<id> deep-link so the
 * user can review / delete what just landed.
 */
export function formatIngestSystemMessage(
  filename: string,
  result: IngestResult,
): string {
  if (result.ok) {
    if (result.duplicateOf) {
      return `📚 **${filename}** matched an existing knowledge entry — using the previous copy. [View](/knowledge?doc=${encodeURIComponent(result.duplicateOf)})`;
    }
    const sizeNote =
      result.extractedChars > 0
        ? ` (${result.chunkCount} chunk${result.chunkCount === 1 ? "" : "s"}, ${formatChars(result.extractedChars)})`
        : "";
    return `✅ Added **${filename}** to your knowledge${sizeNote} — it's now searchable. [Manage](/knowledge?doc=${encodeURIComponent(result.documentId)})`;
  }
  switch (result.code) {
    case "rate_limited":
      return `⏸ Didn't add **${filename}** — ${result.message}`;
    case "unauthorized":
      return `🔒 Didn't add **${filename}** — ${result.message}`;
    case "unsupported":
      return `📎 **${filename}** isn't a supported file type for knowledge ingest. It's still attached to this message.`;
    case "validation":
      return `📎 **${filename}** couldn't be added to knowledge: ${result.message}`;
    case "network":
    case "internal":
      return `⚠️ Couldn't add **${filename}** to knowledge (${result.code}). It's still attached to this message.`;
    default:
      return `⚠️ Couldn't add **${filename}** to knowledge.`;
  }
}

async function safeReadError(res: Response, fallback: string): Promise<string> {
  try {
    const j = await res.json();
    if (j && typeof j === "object" && typeof (j as { error?: string }).error === "string") {
      return (j as { error: string }).error;
    }
  } catch {
    /* not JSON */
  }
  return fallback;
}

function formatChars(n: number): string {
  if (n < 1000) return `${n} chars`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k chars`;
  return `${(n / 1_000_000).toFixed(1)}M chars`;
}
