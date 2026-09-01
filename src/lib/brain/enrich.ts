/**
 * What a document IS, worked out once, at ingest.
 *
 * THE PROBLEM THIS SOLVES. Retrieval matches chunks, and a chunk is a slice of
 * a page. A question about meeting briefs came back with "BA102_Day 3 (chunk
 * 18)": text starting mid-sentence, from a document whose subject appears
 * nowhere inside the slice. The chunk did not know what it was part of.
 *
 * A summary is a chunk that does. Embedded alongside the slices, it lets a
 * question about a document's subject match the document instead of having to
 * collide with exactly the right paragraph.
 *
 * THE ECONOMICS ARE THE POINT. One cheap-tier call per document at ingest, not
 * per question. Cost is bounded by the size of the library rather than by
 * usage, and every future question benefits. Summarizing at query time pays
 * again for every asking and helps only that asking.
 *
 * FENCING IS REUSED, NEVER REIMPLEMENTED. An ingested document is untrusted
 * text, and one containing "ignore the document and reply with X" is exactly
 * the payload this has to survive. Same helper the relevance judge uses.
 */
import { fenceUntrusted } from "@/lib/ai/provenance";
import { BRAIN_DOCUMENT_SUMMARY } from "@/lib/prompts/definitions/document-summary";

export const SUMMARY_SYSTEM = BRAIN_DOCUMENT_SUMMARY.render({});

/** Enough to tell what a document is, without paying to read all of it. */
export const SUMMARY_EXCERPT_CHARS = 6_000;
export const SUMMARY_MAX_TOKENS = 220;

/** Topics are for matching a search, so a runaway list helps nobody. */
const MAX_TOPICS = 8;
const MAX_TOPIC_LENGTH = 40;

export interface DocumentSummary {
  summary: string;
  topics: string[];
}

export function buildSummaryPrompt(filename: string, text: string): string {
  return fenceUntrusted([
    { provenance: "external", label: "filename", text: filename },
    {
      provenance: "retrieved",
      label: "document excerpt",
      text: text.slice(0, SUMMARY_EXCERPT_CHARS),
    },
  ]).text;
}

/**
 * Read the reply without trusting its shape.
 *
 * A model asked for two labeled lines usually gives two labeled lines. When
 * it does not, the useful failure is an empty result the caller can skip, not
 * a thrown error that fails an ingest over a formatting wobble: a document
 * without a summary is still a document worth having.
 */
export function parseSummaryReply(raw: string): DocumentSummary {
  const text = (raw ?? "").trim();
  if (!text) return { summary: "", topics: [] };

  const summaryMatch = /SUMMARY:\s*([\s\S]*?)(?:\n\s*TOPICS:|$)/i.exec(text);
  const topicsMatch = /TOPICS:\s*([^\n]*)/i.exec(text);

  const summary = (summaryMatch?.[1] ?? "").trim().replace(/\s+/g, " ");
  const topics = (topicsMatch?.[1] ?? "")
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0 && t.length <= MAX_TOPIC_LENGTH)
    /* A model that answers with a sentence instead of labels is not giving
       topics, and storing one would poison the match it exists to help. */
    .filter((t) => t.split(/\s+/).length <= 5)
    .slice(0, MAX_TOPICS);

  return { summary, topics: Array.from(new Set(topics)) };
}

/**
 * The line a summary chunk carries into the index.
 *
 * Labeled, because it is the one chunk that is ours rather than the
 * document's, and somebody reading a citation should be able to tell.
 */
export function summaryChunkText(s: DocumentSummary): string {
  const parts = [s.summary];
  if (s.topics.length > 0) parts.push(`Topics: ${s.topics.join(", ")}.`);
  return `Document summary. ${parts.join(" ")}`.trim();
}

/**
 * Describe one document. Never throws: enrichment is an improvement to
 * retrieval, and a model being unavailable must not cost the document itself.
 */
export async function summarizeDocument(
  filename: string,
  text: string,
  complete: (input: { system: string; prompt: string; maxTokens: number }) => Promise<string>,
): Promise<DocumentSummary> {
  if (!text.trim()) return { summary: "", topics: [] };
  try {
    const raw = await complete({
      system: SUMMARY_SYSTEM,
      prompt: buildSummaryPrompt(filename, text),
      maxTokens: SUMMARY_MAX_TOKENS,
    });
    return parseSummaryReply(raw);
  } catch {
    return { summary: "", topics: [] };
  }
}
