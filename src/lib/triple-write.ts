/**
 * Triple-Write Orchestrator — Writes to PG + Qdrant + Neo4j.
 *
 * PG is the primary store (already handled by knowledge.ts / analytics.ts).
 * This module adds Qdrant (vector) and Neo4j (graph) as fire-and-forget
 * secondary writes. Each store is independent — one failure never blocks others.
 *
 * Pattern: Promise.allSettled for independence, never throw.
 */

import { query } from "@/lib/db";
import { upsertKnowledgePoint, getQdrantHealth } from "@/lib/qdrant";
import { recordKnowledgeInteraction, getNeo4jHealth } from "@/lib/neo4j";

export interface TripleWriteStatus {
  pg: boolean;
  qdrant: boolean;
  neo4j: boolean;
}


/**
 * A DEGRADED STORE IS A STATE, NOT AN EVENT STREAM.
 *
 * The architecture doc has always said that triple-write "degrades to
 * Postgres-only and logs system.triple_write_degraded". It did not. Both
 * call sites used Promise.allSettled, which never rejects, so the outer
 * catch was unreachable and every settled result was discarded unread.
 * The event name did not exist in the analytics union either.
 *
 * Measured on production 2026-08-23: Neo4j has never been configured
 * there, the readiness endpoint reports it missing, and the number of
 * degrade events ever recorded is zero. The product has been running as a
 * DOUBLE write while describing itself as a triple write, and the one
 * signal designed to say so was never wired up.
 *
 * TWO THINGS THIS MUST NOT DO.
 *
 * It must not flood. An unconfigured store fails on every single write,
 * so one event per write would be tens of thousands of identical rows a
 * day, which is a worse kind of silence. It reports the transition and
 * then stays quiet, which is what somebody reading the table actually
 * wants: when did we stop writing to the graph.
 *
 * And it must not recurse. analytics.ts calls tripleWriteEvent, so
 * reporting a failure through trackEvent would be a loop that feeds
 * itself. The row is written straight to the table instead, and any
 * failure doing so is swallowed: a diagnostic that breaks the thing it
 * is diagnosing is not worth having.
 */
const reported = new Set<string>();

async function reportDegraded(store: "qdrant" | "neo4j", reason: string): Promise<void> {
  if (reported.has(store)) return;
  reported.add(store);
  if (!process.env.DATABASE_URL) return;
  try {
    const ts = new Date().toISOString();
    await query(
      `INSERT INTO instinct_events (event_type, user_id, user_role, metadata, timestamp)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        "system.triple_write_degraded",
        "system",
        "system",
        JSON.stringify({ store, reason: reason.slice(0, 200), ts }),
        ts,
      ],
    );
  } catch {
    /* Never let the diagnostic break the write it was diagnosing. */
  }
}

/** Read the settled results and report the first failure of each store. */
function inspect(results: PromiseSettledResult<unknown>[], stores: Array<"qdrant" | "neo4j">): void {
  results.forEach((r, i) => {
    const store = stores[i];
    if (!store) return;
    if (r.status === "rejected") {
      void reportDegraded(store, String((r.reason as Error)?.message ?? r.reason ?? "unknown"));
    } else if (r.value === false) {
      /* A store client that returns false rather than throwing when it is
         unconfigured is still a store that did not receive the write. */
      void reportDegraded(store, "not configured");
    }
  });
}

/**
 * Write knowledge to all 3 stores.
 * PG write is already done by knowledge.ts — this adds Qdrant + Neo4j.
 */
export async function tripleWriteKnowledge(
  id: string,
  question: string,
  answer: string,
  source: string,
  userId: string,
  tags: string[],
  repo?: string,
): Promise<void> {
  try {
    const results = await Promise.allSettled([
      // Qdrant: vector embedding for semantic search
      upsertKnowledgePoint(id, question, answer, source, tags, repo),
      // Neo4j: graph relationship
      recordKnowledgeInteraction(userId, id, "ANSWERED", question),
    ]);
    inspect(results, ["qdrant", "neo4j"]);
  } catch {
    // Triple-write is fire-and-forget
  }
}

/**
 * Write an event to secondary stores (Qdrant metadata + Neo4j activity node).
 * PG write is already done by analytics.ts.
 */
export async function tripleWriteEvent(event: {
  event_type: string;
  user_id: string;
  user_role: string;
  metadata: Record<string, string | number | boolean>;
}): Promise<void> {
  try {
    const results = await Promise.allSettled([
      // Qdrant: store event metadata for pattern discovery
      upsertKnowledgePoint(
        `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        event.event_type,
        JSON.stringify(event.metadata),
        "event",
        [event.event_type, event.user_role],
      ),
      // Neo4j: record activity for the user
      recordKnowledgeInteraction(
        event.user_id,
        `evt-${event.event_type}`,
        "ASKED",
        event.event_type,
      ),
    ]);
    inspect(results, ["qdrant", "neo4j"]);
  } catch {
    // Fire-and-forget
  }
}

/**
 * Check health of all 3 stores.
 */
export async function getTripleWriteStatus(): Promise<TripleWriteStatus> {
  const [qdrantResult, neo4jResult] = await Promise.allSettled([
    getQdrantHealth(),
    getNeo4jHealth(),
  ]);

  return {
    pg: !!process.env.DATABASE_URL,
    qdrant:
      qdrantResult.status === "fulfilled" ? qdrantResult.value : false,
    neo4j:
      neo4jResult.status === "fulfilled" ? neo4jResult.value : false,
  };
}
