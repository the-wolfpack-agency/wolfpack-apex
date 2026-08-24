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
const AZURE_KEYS = ["AZURE_OPENAI_ENDPOINT", "AZURE_OPENAI_API_KEY", "AZURE_OPENAI_EMBEDDING_DEPLOYMENT"] as const;

/** True when this deployment is configured to embed via Azure. */
function azureConfigured(): boolean {
  return AZURE_KEYS.every((k) => Boolean(process.env[k]));
}
const DEFAULT_MODEL = "text-embedding-3-small";
export const EMBED_DIM = 1536;

export interface EmbedResult {
  vectors: number[][];
  tokensUsed: number;
  model: string;
}

/**
 * THIS ANSWERED NO IN PRODUCTION FOR THE WHOLE LIFE OF THE FEATURE.
 *
 * It asked for OPENAI_API_KEY or BRAIN_EMBEDDING_KEY. This deployment runs
 * Azure OpenAI and has never had either, so the semantic half of every brain
 * search was skipped: not failed, not caught, never run. Measured 2026-08-24:
 * 2,305 chunks across 779 documents with embedded=false, every one, and 252
 * brain queries over 30 days with zero semantic hits.
 *
 * The same shape as #377, where the router decided a model was unreachable by
 * looking for an OpenAI key. A deployment is not OpenAI just because the code
 * was written against it.
 */
export function isEmbeddingConfigured(): boolean {
  return azureConfigured() || Boolean(process.env.OPENAI_API_KEY || process.env.BRAIN_EMBEDDING_KEY);
}

/** Which way this deployment embeds, for the degrade event and the backfill. */
export function embeddingBackend(): "azure" | "openai" | "none" {
  if (azureConfigured()) return "azure";
  if (process.env.OPENAI_API_KEY || process.env.BRAIN_EMBEDDING_KEY) return "openai";
  return "none";
}

export async function embedBatch(texts: string[]): Promise<EmbedResult | null> {
  if (!isEmbeddingConfigured()) return null;
  if (texts.length === 0) return { vectors: [], tokensUsed: 0, model: DEFAULT_MODEL };

  /* AZURE FIRST, THROUGH THE ADAPTER THAT ALREADY EXISTED.
     createAzureOpenAIEmbedder was written, tested and never called, because
     the factory that should have returned it threw a TODO and this file went
     straight to api.openai.com. Deployment-name routing, api-key header: an
     Azure call is not an OpenAI call with a different host. */
  if (azureConfigured()) {
    const { getEmbeddingProvider } = await import("@/lib/rag-providers/factory");
    const provider = getEmbeddingProvider();
    const vectors = await provider.embed(texts);
    return {
      vectors,
      /* Azure returns usage per call; the adapter does not surface it yet, and
         a made-up number is worse than an honest zero. */
      tokensUsed: 0,
      model: provider.model,
    };
  }

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
