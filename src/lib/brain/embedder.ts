/**
 * Brain embedder — real embeddings when available, graceful skip when not.
 *
 * Strategy:
 *   - If OPENAI_API_KEY is set, use `text-embedding-3-small` (1536 dims).
 *     Cost ≈ $0.02/1M tokens. Fits easily in Vercel Function runtime —
 *     raw fetch to api.openai.com, no SDK.
 *   - If the key is absent, return null. Callers treat null as "skip
 *     Qdrant write, index with keyword-FTS only" and mark the chunk as
 *     `embedded = false`. A later reconciler can embed the backlog once
 *     the key is configured.
 *
 * Embeddings are never a hard requirement — the Brain must work from
 * day one in environments without the key. Postgres full-text search
 * alone is acceptable retrieval for the common case; semantic is an
 * upgrade, not a floor.
 */

const EMBED_URL = "https://api.openai.com/v1/embeddings";
const DEFAULT_MODEL = "text-embedding-3-small";
export const EMBED_DIM = 1536;

export interface EmbedResult {
  vectors: number[][];
  tokensUsed: number;
  model: string;
}

export function isEmbeddingConfigured(): boolean {
  return Boolean(process.env.OPENAI_API_KEY || process.env.BRAIN_EMBEDDING_KEY);
}

export async function embedBatch(texts: string[]): Promise<EmbedResult | null> {
  if (!isEmbeddingConfigured()) return null;
  if (texts.length === 0) return { vectors: [], tokensUsed: 0, model: DEFAULT_MODEL };

  const key = process.env.BRAIN_EMBEDDING_KEY || process.env.OPENAI_API_KEY!;
  const model = process.env.BRAIN_EMBEDDING_MODEL || DEFAULT_MODEL;

  const res = await fetch(EMBED_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ model, input: texts }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`embed API ${res.status}: ${detail.slice(0, 200)}`);
  }

  const body = (await res.json()) as {
    data: { embedding: number[]; index: number }[];
    usage?: { total_tokens?: number };
    model: string;
  };

  // The API guarantees ordered responses, but we re-sort by `index` as
  // belt-and-braces — a silent reorder would corrupt chunk→vector
  // association and be hell to debug later.
  const sorted = [...body.data].sort((a, b) => a.index - b.index);
  const vectors = sorted.map((d) => d.embedding);

  return {
    vectors,
    tokensUsed: body.usage?.total_tokens ?? 0,
    model: body.model ?? model,
  };
}
