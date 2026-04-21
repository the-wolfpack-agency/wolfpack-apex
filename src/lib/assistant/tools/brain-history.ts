/**
 * brain_history tool — Qdrant RAG over the Brain store.
 *
 * Answers "how long was the Porsche engagement?" / "summarize the
 * Greenfield project" / "history of X" style questions by pulling
 * the top-K Brain chunks whose payload matches the subject hint.
 *
 * Zero AI tokens. Uses lexical + vector hybrid search that's already
 * in place (searchBrain on src/lib/brain/qdrant.ts). If no subject
 * hint was extracted, returns null so the orchestrator falls back.
 */

import { keywordSearch, type KeywordHit } from "@/lib/brain/repo";

export interface BrainHistoryResult {
  subject: string;
  timeframeLabel?: string;
  /** Up to 5 top chunks with their payload content + source. */
  hits: Array<{ score: number; content: string; source?: string; docId?: string }>;
  answer: string;
  source: "brain";
}

export async function runBrainHistory(params: {
  subject: string;
  timeframeLabel?: string;
  limit?: number;
}): Promise<BrainHistoryResult | null> {
  const subject = params.subject.trim();
  if (!subject) return null;
  const limit = Math.max(1, Math.min(params.limit ?? 5, 10));

  let hits: KeywordHit[] = [];
  try {
    hits = await keywordSearch(subject, limit);
  } catch {
    return null;
  }
  if (!hits || hits.length === 0) return null;

  const compact = hits.slice(0, limit).map((h) => ({
    score: typeof h.score === "number" ? h.score : 0,
    content: String(h.headline || h.content || "").slice(0, 400),
    source: h.kind,
    docId: h.document_id,
  }));

  const preview = compact
    .slice(0, 3)
    .map((c, i) => `${i + 1}. ${c.content.split(/\n+/)[0].slice(0, 160)}`)
    .join("\n");

  const answer = `Top ${compact.length} Brain hit${compact.length === 1 ? "" : "s"} for "${subject}"${params.timeframeLabel ? ` (${params.timeframeLabel})` : ""}:\n${preview}`;

  return {
    subject,
    timeframeLabel: params.timeframeLabel,
    hits: compact,
    answer,
    source: "brain",
  };
}
