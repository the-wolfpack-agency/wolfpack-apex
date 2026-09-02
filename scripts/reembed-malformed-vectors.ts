/* FIRST. Imports hoist, so anything below already read process.env. */
import "./load-env";

/**
 * Rewrite the vectors whose payload has no text.
 *
 * WHAT LEFT THEM THAT WAY. The library repair wrote three payload fields and
 * omitted content, so every document it ever fixed produced points the reader
 * cannot use. Measured 2026-09-02: 731 of 5,737, 12.7% of the collection. The
 * writer is fixed and the reader now skips them instead of throwing, so they
 * can no longer break a query. They still cannot be FOUND, which is the part
 * this repairs.
 *
 * WHY THE EXISTING BACKFILL WILL NOT DO IT. That job embeds chunks where
 * embedded = FALSE. These were marked embedded, truthfully: a vector was
 * written. It was simply written without the text. So the flag says done and
 * the point is useless, which is the same shape as everything else found this
 * week and the reason this needs its own pass.
 *
 * IT ASKS THE VECTOR STORE, NOT POSTGRES, which points are bad. Postgres has no
 * idea: as far as it knows every one of these chunks is embedded. The only
 * system that can tell is the one holding the broken payloads.
 *
 * DRY RUN unless --apply. Bounded by --limit so a first run can be small.
 *
 *   npx tsx scripts/reembed-malformed-vectors.ts
 *   npx tsx scripts/reembed-malformed-vectors.ts --apply --limit 250
 */

import { Client } from "pg";
import { embedBatch, isEmbeddingConfigured } from "@/lib/brain/embedder";
import { upsertBrainPoints } from "@/lib/brain/qdrant";

const COLLECTION = process.env.BRAIN_QDRANT_COLLECTION || "apex_brain";
/** Embedding calls are the cost here; a batch that is too large also times out. */
const BATCH = 32;

/**
 * Embed with backoff, because the limit here is per minute, not per request.
 *
 * The first run did four batches of 64 and then got null on the fifth. Not a
 * size problem: the largest chunk in the corpus is 2,840 characters and the
 * same batch size had just worked four times. embedBatch returns null on any
 * failure and swallows the reason, so a rate limit and a broken deployment
 * arrive identically, and stopping on the first null turned a pause into a
 * halt at 256 of 731.
 *
 * Waits and retries rather than shrinking alone, since a smaller batch hits the
 * same ceiling a little later.
 */
async function embedWithBackoff(texts: string[]): Promise<number[][] | null> {
  const waits = [0, 5_000, 15_000, 45_000];
  for (const wait of waits) {
    if (wait) {
      console.log(`    paused ${wait / 1000}s (the embedder declined; retrying)`);
      await new Promise((r) => setTimeout(r, wait));
    }
    const res = await embedBatch(texts);
    if (res && res.vectors.length === texts.length) return res.vectors;
  }
  return null;
}

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? (process.argv[i + 1] ?? null) : null;
}

/** Point ids in the collection whose payload carries no usable text. */
async function findMalformed(limit: number): Promise<string[]> {
  const url = (process.env.QDRANT_URL ?? "").replace(/\/+$/, "");
  const key = process.env.QDRANT_API_KEY ?? "";
  const bad: string[] = [];
  let offset: unknown = undefined;

  for (let page = 0; page < 40 && bad.length < limit; page++) {
    const res = await fetch(`${url}/collections/${COLLECTION}/points/scroll`, {
      method: "POST",
      headers: { "api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ limit: 500, with_payload: true, offset }),
    });
    if (!res.ok) throw new Error(`qdrant scroll -> HTTP ${res.status}`);
    const body = (await res.json()) as {
      result?: { points?: Array<{ id: string; payload?: { content?: unknown } }>; next_page_offset?: unknown };
    };
    const points = body.result?.points ?? [];
    if (points.length === 0) break;
    for (const p of points) {
      if (typeof p.payload?.content !== "string" || p.payload.content.length === 0) {
        bad.push(String(p.id));
        if (bad.length >= limit) break;
      }
    }
    offset = body.result?.next_page_offset;
    if (!offset) break;
  }
  return bad;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const limit = Number(arg("limit") ?? 1000);

  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set.");
    process.exit(2);
  }
  if (!isEmbeddingConfigured()) {
    /* REFUSED, not "nothing to do". Without an embedder this would find every
       bad point and repair none, and a run that reports zero repaired for that
       reason reads exactly like a clean corpus. */
    console.error("No embedder is configured, so nothing can be re-embedded.");
    console.error("Check AZURE_OPENAI_* — this would otherwise report a clean run having fixed nothing.");
    process.exit(1);
  }

  console.log(`Scanning ${COLLECTION} for points with no text...`);
  const badIds = await findMalformed(limit);
  console.log(`${badIds.length} point(s) carry no content.`);
  if (badIds.length === 0) {
    console.log("Nothing to repair.");
    return;
  }

  const db = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await db.connect();

  try {
    /* The chunk text and the document it belongs to, which is everything the
       payload should have carried in the first place. */
    const { rows } = await db.query<{
      id: string;
      document_id: string;
      chunk_idx: number;
      content: string;
      filename: string;
      kind: string;
      uploaded_by: string | null;
    }>(
      `SELECT bc.id::text AS id, bc.document_id::text AS document_id, bc.chunk_idx,
              bc.content, bd.filename, bd.kind, bd.uploaded_by::text AS uploaded_by
         FROM brain_chunks bc
         JOIN brain_documents bd ON bd.id = bc.document_id
        WHERE bc.id = ANY($1::uuid[])`,
      [badIds],
    );

    /* A point whose chunk is gone cannot be repaired and should not be left to
       be rediscovered on every future run. Reported, not silently dropped. */
    const orphaned = badIds.length - rows.length;
    if (orphaned > 0) {
      console.log(`${orphaned} point(s) have no chunk row left; they can only be deleted, not rebuilt.`);
    }
    console.log(`${rows.length} can be rebuilt from their chunk text.`);

    if (!apply) {
      console.log("\nDRY RUN. Nothing written. Re-run with --apply.");
      return;
    }

    let repaired = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH);
      const vectors = await embedWithBackoff(batch.map((r) => r.content));
      if (!vectors) {
        console.error(`  batch at ${i} still refused after retries; stopping so the count stays honest.`);
        break;
      }
      await upsertBrainPoints(
        batch.map((r, n) => ({
          id: r.id,
          vector: vectors[n],
          payload: {
            document_id: r.document_id,
            chunk_id: r.id,
            chunk_idx: r.chunk_idx,
            filename: r.filename,
            kind: r.kind,
            uploaded_by: r.uploaded_by ?? "",
            tags: [],
            content: r.content,
            created_at: new Date().toISOString(),
          },
        })) as never,
      );
      repaired += batch.length;
      console.log(`  ${repaired}/${rows.length}`);
    }

    console.log(`\nRebuilt ${repaired} point(s) with their text.`);
    console.log("Re-run without --apply to confirm the count has fallen.");
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error("failed:", (err as Error).message);
  process.exit(1);
});
