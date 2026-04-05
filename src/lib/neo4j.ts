/**
 * Neo4j Client — Team knowledge graph for Wolfpack Apex.
 *
 * Triple-write secondary store. Builds a graph of team interactions:
 *   (:TeamMember)-[:ASKED|:ANSWERED|:RATED]->(:Question)
 *   (:TeamMember)-[:COLLABORATED_WITH]->(:TeamMember) via (:Discussion)
 *   (:TeamMember)-[:GENERATED]->(:Document)-[:FROM_FILE]->(:CodeFile)
 *
 * All operations are fire-and-forget via fetch to Neo4j HTTP API.
 * Uses parameterized Cypher queries.
 */

function getNeo4jUrl(): string | null {
  return process.env.NEO4J_URI || process.env.NEO4J_URL || null;
}

function getNeo4jAuth(): { username: string; password: string } {
  return {
    username: process.env.NEO4J_USER || "neo4j",
    password: process.env.NEO4J_PASSWORD || "neo4j",
  };
}

/**
 * Execute a Cypher query via Neo4j HTTP API.
 * Returns the result rows or empty array on failure.
 */
async function executeCypher(
  cypher: string,
  parameters: Record<string, unknown> = {},
): Promise<Record<string, unknown>[]> {
  const url = getNeo4jUrl();
  if (!url) return [];

  const auth = getNeo4jAuth();
  const httpUrl = url.replace(/^bolt:\/\//, "http://").replace(/:7687/, ":7474");
  const endpoint = `${httpUrl}/db/neo4j/tx/commit`;

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization:
          "Basic " +
          Buffer.from(`${auth.username}:${auth.password}`).toString("base64"),
      },
      body: JSON.stringify({
        statements: [{ statement: cypher, parameters }],
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) return [];

    const data = (await res.json()) as {
      results?: Array<{
        columns?: string[];
        data?: Array<{ row?: unknown[] }>;
      }>;
    };

    if (!data.results?.[0]?.data) return [];

    const columns = data.results[0].columns ?? [];
    return data.results[0].data.map((d) => {
      const row: Record<string, unknown> = {};
      columns.forEach((col, i) => {
        row[col] = d.row?.[i];
      });
      return row;
    });
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Record a knowledge interaction in the graph.
 * Creates: (:TeamMember {id})-[:ASKED|:ANSWERED|:RATED]->(:Question {id, text})
 */
export async function recordKnowledgeInteraction(
  userId: string,
  questionId: string,
  action: "ASKED" | "ANSWERED" | "RATED",
  questionText?: string,
): Promise<void> {
  const url = getNeo4jUrl();
  if (!url) return;

  try {
    await executeCypher(
      `MERGE (u:TeamMember {id: $userId})
       MERGE (q:Question {id: $questionId})
       ON CREATE SET q.text = $questionText, q.created_at = datetime()
       MERGE (u)-[r:${action}]->(q)
       ON CREATE SET r.created_at = datetime()
       ON MATCH SET r.updated_at = datetime()`,
      { userId, questionId, questionText: questionText ?? "" },
    );
  } catch {
    // Fire-and-forget
  }
}

/**
 * Record collaboration between two team members.
 * Creates: (:TeamMember)-[:COLLABORATED_WITH]->(:TeamMember) via (:Discussion)
 */
export async function recordCollaboration(
  userId1: string,
  userId2: string,
  threadId: string,
): Promise<void> {
  const url = getNeo4jUrl();
  if (!url) return;

  try {
    await executeCypher(
      `MERGE (u1:TeamMember {id: $userId1})
       MERGE (u2:TeamMember {id: $userId2})
       MERGE (d:Discussion {id: $threadId})
       ON CREATE SET d.created_at = datetime()
       MERGE (u1)-[:PARTICIPATED_IN]->(d)
       MERGE (u2)-[:PARTICIPATED_IN]->(d)
       MERGE (u1)-[c:COLLABORATED_WITH]->(u2)
       ON CREATE SET c.thread_count = 1
       ON MATCH SET c.thread_count = c.thread_count + 1`,
      { userId1, userId2, threadId },
    );
  } catch {
    // Fire-and-forget
  }
}

/**
 * Record a document generation event in the graph.
 * Creates: (:TeamMember)-[:GENERATED]->(:Document)-[:FROM_FILE]->(:CodeFile)
 */
export async function recordDocGeneration(
  userId: string,
  docId: string,
  sourceRepo: string,
  sourceFile: string,
): Promise<void> {
  const url = getNeo4jUrl();
  if (!url) return;

  try {
    await executeCypher(
      `MERGE (u:TeamMember {id: $userId})
       MERGE (d:Document {id: $docId})
       ON CREATE SET d.created_at = datetime()
       MERGE (f:CodeFile {repo: $sourceRepo, path: $sourceFile})
       MERGE (u)-[:GENERATED]->(d)
       MERGE (d)-[:FROM_FILE]->(f)`,
      { userId, docId, sourceRepo, sourceFile },
    );
  } catch {
    // Fire-and-forget
  }
}

/**
 * Get the knowledge graph for a user (or all users).
 * Returns questions asked, docs generated, collaborations.
 */
export async function getKnowledgeGraph(
  userId?: string,
): Promise<{
  questions: Array<{ id: string; text: string; action: string }>;
  documents: Array<{ id: string; repo: string; path: string }>;
  collaborators: Array<{ id: string; thread_count: number }>;
}> {
  const url = getNeo4jUrl();
  if (!url) {
    return { questions: [], documents: [], collaborators: [] };
  }

  try {
    const userFilter = userId
      ? "WHERE u.id = $userId"
      : "";

    const [questions, documents, collaborators] = await Promise.all([
      executeCypher(
        `MATCH (u:TeamMember)-[r]->(q:Question) ${userFilter}
         RETURN q.id AS id, q.text AS text, type(r) AS action LIMIT 50`,
        { userId: userId ?? "" },
      ),
      executeCypher(
        `MATCH (u:TeamMember)-[:GENERATED]->(d:Document)-[:FROM_FILE]->(f:CodeFile) ${userFilter}
         RETURN d.id AS id, f.repo AS repo, f.path AS path LIMIT 50`,
        { userId: userId ?? "" },
      ),
      executeCypher(
        `MATCH (u:TeamMember)-[c:COLLABORATED_WITH]->(other:TeamMember) ${userFilter}
         RETURN other.id AS id, c.thread_count AS thread_count LIMIT 50`,
        { userId: userId ?? "" },
      ),
    ]);

    return {
      questions: questions.map((r) => ({
        id: String(r.id ?? ""),
        text: String(r.text ?? ""),
        action: String(r.action ?? ""),
      })),
      documents: documents.map((r) => ({
        id: String(r.id ?? ""),
        repo: String(r.repo ?? ""),
        path: String(r.path ?? ""),
      })),
      collaborators: collaborators.map((r) => ({
        id: String(r.id ?? ""),
        thread_count: Number(r.thread_count ?? 0),
      })),
    };
  } catch {
    return { questions: [], documents: [], collaborators: [] };
  }
}

/**
 * Check Neo4j health.
 */
export async function getNeo4jHealth(): Promise<boolean> {
  const url = getNeo4jUrl();
  if (!url) return false;

  try {
    const result = await executeCypher("RETURN 1 AS ok");
    return result.length > 0;
  } catch {
    return false;
  }
}

// Export for testing
export { executeCypher, getNeo4jUrl };
