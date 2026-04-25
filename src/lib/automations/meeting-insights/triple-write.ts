/**
 * meeting-insights / triple-write — fan an analysis row out to Qdrant
 * and Neo4j alongside the canonical Postgres write.
 *
 * Hard rules:
 *   - Postgres is the source of truth; Qdrant + Neo4j are advisory.
 *   - Every write here is fire-and-forget. Never throw, never block.
 *     If Qdrant or Neo4j is down the analyzer still succeeds.
 *   - The graph writes are MERGEs, so re-running them is idempotent.
 *   - For Qdrant we use the standard 4-dim zero-vector convention from
 *     `src/lib/qdrant.ts` until a real embedding provider is wired up.
 *     The semantic-search query helper (themes.ts) currently degrades
 *     gracefully to keyword search via the topics[] array; once
 *     embeddings come online, only the search side needs an upgrade.
 *
 * Phase 3 graph shape:
 *   (:Message {id, feed_id, received_at, subject})
 *     -[:DISCUSSED]->(:Topic {name})
 *     -[:RAISED_IN]->(:Meeting {feed_id})
 *   (:Message)-[:OWNED_BY]->(:Person {key})   for action_item.owner
 *   (:Topic)-[:RAISED_IN]->(:Meeting {feed_id})
 */

const QDRANT_COLLECTION = "meeting-insights";

interface AnalysisFanoutInput {
  message_id: string;
  feed_id: string;
  received_at: string;
  subject: string;
  topics: string[];
  action_items: Array<{ description: string; owner?: string }>;
  /** Short summary text used as the Qdrant payload + semantic search target. */
  summary_text: string;
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

export async function fanoutAnalysisToSecondaries(
  input: AnalysisFanoutInput,
): Promise<{ qdrant: boolean; neo4j: boolean }> {
  const [q, n] = await Promise.allSettled([
    writeAnalysisToQdrant(input),
    writeAnalysisToNeo4j(input),
  ]);
  return {
    qdrant: q.status === "fulfilled" ? q.value : false,
    neo4j: n.status === "fulfilled" ? n.value : false,
  };
}

/* ------------------------------------------------------------------ */
/* Qdrant                                                              */
/* ------------------------------------------------------------------ */

async function writeAnalysisToQdrant(
  input: AnalysisFanoutInput,
): Promise<boolean> {
  const url = process.env.QDRANT_URL;
  if (!url) return false;

  try {
    await ensureMeetingCollection(url);

    // Pseudo-embedding (4-dim zero vector). The payload carries the
    // searchable text + metadata so themes.semanticSearch can fall back
    // to filtered scrolls when no real embedder is configured.
    await fetch(`${url}/collections/${QDRANT_COLLECTION}/points`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        points: [
          {
            id: hashToInt(input.message_id),
            vector: [0, 0, 0, 0],
            payload: {
              message_id: input.message_id,
              feed_id: input.feed_id,
              received_at: input.received_at,
              subject: input.subject,
              topics: input.topics,
              summary_text: input.summary_text.slice(0, 4000),
              indexed_at: new Date().toISOString(),
            },
          },
        ],
      }),
      signal: AbortSignal.timeout(5000),
    });
    return true;
  } catch {
    return false;
  }
}

async function ensureMeetingCollection(url: string): Promise<void> {
  try {
    const check = await fetch(`${url}/collections/${QDRANT_COLLECTION}`, {
      signal: AbortSignal.timeout(3000),
    });
    if (check.ok) return;
    await fetch(`${url}/collections/${QDRANT_COLLECTION}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vectors: { size: 4, distance: "Cosine" },
      }),
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    /* best-effort */
  }
}

function hashToInt(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  }
  return hash || 1;
}

/* ------------------------------------------------------------------ */
/* Neo4j                                                               */
/* ------------------------------------------------------------------ */

async function writeAnalysisToNeo4j(
  input: AnalysisFanoutInput,
): Promise<boolean> {
  const url = process.env.NEO4J_URI || process.env.NEO4J_URL;
  if (!url) return false;

  const username = process.env.NEO4J_USER || "neo4j";
  const password = process.env.NEO4J_PASSWORD || "neo4j";
  const httpUrl = url
    .replace(/^bolt:\/\//, "http://")
    .replace(/:7687/, ":7474");
  const endpoint = `${httpUrl}/db/neo4j/tx/commit`;

  // We send ONE cypher statement that MERGEs the message + each topic +
  // owner. UNWIND keeps the round-trip count down.
  const cypher = `
    MERGE (m:Message {id: $message_id})
      ON CREATE SET m.created_at = datetime()
      SET m.feed_id = $feed_id,
          m.received_at = $received_at,
          m.subject = $subject,
          m.updated_at = datetime()
    MERGE (mt:Meeting {feed_id: $feed_id})
    MERGE (m)-[:RAISED_IN]->(mt)
    WITH m, mt
    UNWIND $topics AS topic
      MERGE (t:Topic {name: topic})
      MERGE (m)-[:DISCUSSED]->(t)
      MERGE (t)-[:RAISED_IN]->(mt)
    WITH m
    UNWIND $owners AS owner
      MERGE (p:Person {key: owner})
      MERGE (m)-[:OWNED_BY]->(p)
    RETURN 1 AS ok
  `;

  const owners = Array.from(
    new Set(
      input.action_items
        .map((ai) => (ai.owner ?? "").trim().toLowerCase())
        .filter((o) => o.length > 0),
    ),
  );

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization:
          "Basic " +
          Buffer.from(`${username}:${password}`).toString("base64"),
      },
      body: JSON.stringify({
        statements: [
          {
            statement: cypher,
            parameters: {
              message_id: input.message_id,
              feed_id: input.feed_id,
              received_at: input.received_at,
              subject: input.subject,
              topics: input.topics,
              owners,
            },
          },
        ],
      }),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Test exports                                                        */
/* ------------------------------------------------------------------ */
export const __test__ = {
  hashToInt,
  QDRANT_COLLECTION,
};
