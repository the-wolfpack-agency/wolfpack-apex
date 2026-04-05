/**
 * Triple-Write Orchestrator — Writes to PG + Qdrant + Neo4j.
 *
 * PG is the primary store (already handled by knowledge.ts / analytics.ts).
 * This module adds Qdrant (vector) and Neo4j (graph) as fire-and-forget
 * secondary writes. Each store is independent — one failure never blocks others.
 *
 * Pattern: Promise.allSettled for independence, never throw.
 */

import { upsertKnowledgePoint, getQdrantHealth } from "@/lib/qdrant";
import { recordKnowledgeInteraction, getNeo4jHealth } from "@/lib/neo4j";

export interface TripleWriteStatus {
  pg: boolean;
  qdrant: boolean;
  neo4j: boolean;
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
    await Promise.allSettled([
      // Qdrant: vector embedding for semantic search
      upsertKnowledgePoint(id, question, answer, source, tags, repo),
      // Neo4j: graph relationship
      recordKnowledgeInteraction(userId, id, "ANSWERED", question),
    ]);
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
    await Promise.allSettled([
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
