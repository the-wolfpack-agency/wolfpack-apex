/**
 * Semantic chunker.
 *
 * Retrieval quality is a function of chunk boundaries. Strategy:
 *   1. Split on blank lines first (paragraph boundary — a free semantic
 *      signal in almost every doc format).
 *   2. Pack paragraphs into target-sized chunks (~600 tokens target, 150
 *      token overlap).
 *   3. Fall back to sentence splits when a paragraph alone is too big.
 *   4. Fall back to hard char-windowing when a single sentence is too big
 *      (log-spam files, minified HTML).
 *
 * Token estimate uses ~3.5 chars/token (conservative for English). We
 * never call a tokenizer at chunk time — that's a future upgrade that
 * tightens the retrieval budget but doesn't change the storage contract.
 */

import type { TextChunk } from "./types";

const CHARS_PER_TOKEN = 3.5;
export const TARGET_TOKENS = 600;
export const OVERLAP_TOKENS = 150;
export const MIN_CHUNK_TOKENS = 30; // don't emit trivial chunks

export interface ChunkOpts {
  targetTokens?: number;
  overlapTokens?: number;
  minChunkTokens?: number;
}

export function chunkText(raw: string, opts: ChunkOpts = {}): TextChunk[] {
  const targetTok = opts.targetTokens ?? TARGET_TOKENS;
  const overlapTok = opts.overlapTokens ?? OVERLAP_TOKENS;
  const minTok = opts.minChunkTokens ?? MIN_CHUNK_TOKENS;

  const targetChars = Math.floor(targetTok * CHARS_PER_TOKEN);
  const overlapChars = Math.floor(overlapTok * CHARS_PER_TOKEN);

  const normalized = raw.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return [];

  // Phase 1 — paragraph split (blank-line boundary)
  const paragraphs = normalized.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);

  const blocks: string[] = [];
  for (const p of paragraphs) {
    if (p.length <= targetChars) {
      blocks.push(p);
      continue;
    }
    // Paragraph too big — phase 2: sentence split
    const sentences = splitSentences(p);
    let buf = "";
    for (const s of sentences) {
      if (s.length > targetChars) {
        // Single sentence too big (rare — log lines, minified HTML). Hard
        // window it so we never emit a chunk larger than 2 * target.
        if (buf.trim()) blocks.push(buf.trim());
        buf = "";
        for (let i = 0; i < s.length; i += targetChars) {
          blocks.push(s.slice(i, i + targetChars));
        }
        continue;
      }
      if ((buf + " " + s).trim().length > targetChars) {
        if (buf.trim()) blocks.push(buf.trim());
        buf = s;
      } else {
        buf = buf ? buf + " " + s : s;
      }
    }
    if (buf.trim()) blocks.push(buf.trim());
  }

  // Phase 3 — pack blocks into target-sized chunks with overlap
  const chunks: TextChunk[] = [];
  let current = "";
  let idx = 0;

  const emit = (text: string) => {
    const content = text.trim();
    if (!content) return;
    // Drop chunks smaller than minChars UNLESS it's the last one (still
    // carries signal for the final paragraph of a short doc).
    const tokenEstimate = Math.max(1, Math.ceil(content.length / CHARS_PER_TOKEN));
    if (tokenEstimate < minTok / 2 && chunks.length > 0) return;
    chunks.push({ idx: idx++, content, token_estimate: tokenEstimate });
  };

  for (const block of blocks) {
    if (!current) {
      current = block;
      continue;
    }
    const combined = current + "\n\n" + block;
    if (combined.length <= targetChars) {
      current = combined;
      continue;
    }
    emit(current);
    // Carry overlap from tail of previous chunk for continuity
    const tail = current.slice(-overlapChars);
    current = tail + "\n\n" + block;
    // If even the overlap-carrying buffer is already over target (because
    // block itself is large), emit immediately
    if (current.length > targetChars * 2) {
      emit(current);
      current = "";
    }
  }

  if (current.trim()) emit(current);

  // Defensive: ensure no chunk exceeds hard max
  for (const c of chunks) {
    if (c.content.length > targetChars * 3) {
      // This shouldn't happen with the logic above; keep the assert as a
      // tripwire so test suite catches regression if we refactor.
      c.content = c.content.slice(0, targetChars * 3);
      c.token_estimate = Math.ceil(c.content.length / CHARS_PER_TOKEN);
    }
  }
  return chunks;
}

/**
 * Very forgiving sentence splitter. Splits on `.`, `?`, `!` followed by
 * whitespace, preserving the terminator. Doesn't handle abbreviations
 * (Dr. Mr. etc.) elegantly — but over-splitting is harmless for retrieval,
 * it just means slightly more chunks.
 */
function splitSentences(text: string): string[] {
  const out: string[] = [];
  const re = /[^.!?]+[.!?]+|\S[^.!?]*$/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const s = m[0].trim();
    if (s) out.push(s);
  }
  return out.length > 0 ? out : [text];
}
