/**
 * Triple-Write Architecture Tests
 *
 * Verifies Qdrant, Neo4j, and triple-write orchestration.
 * All external calls are mocked — tests run without infrastructure.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// Global fetch mock
// ---------------------------------------------------------------------------
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

// ---------------------------------------------------------------------------
// DB mock (for knowledge.ts and analytics.ts integration)
// ---------------------------------------------------------------------------
const mockQuery = jest.fn();
const mockSafeQuery = jest.fn();

jest.mock("@/lib/db", () => ({
  query: (...args: any[]) => mockQuery(...args),
  safeQuery: (...args: any[]) => mockSafeQuery(...args),
}));

jest.mock("@/lib/analytics", () => ({
  trackEvent: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function setEnv(key: string, val: string | undefined) {
  if (val === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = val;
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  mockFetch.mockReset();
  delete process.env.QDRANT_URL;
  delete process.env.NEO4J_URI;
  delete process.env.NEO4J_URL;
  delete process.env.DATABASE_URL;
});

afterEach(() => {
  delete process.env.QDRANT_URL;
  delete process.env.NEO4J_URI;
  delete process.env.NEO4J_URL;
  delete process.env.DATABASE_URL;
});

// ===========================================================================
// Qdrant Client
// ===========================================================================
describe("Qdrant Client", () => {
  let qdrant: typeof import("@/lib/qdrant");

  beforeEach(() => {
    jest.isolateModules(() => {
      qdrant = require("@/lib/qdrant");
    });
  });

  test("upsertKnowledgePoint skips when QDRANT_URL not set", async () => {
    await qdrant.upsertKnowledgePoint("id1", "Q?", "A.", "docs", ["tag1"]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("upsertKnowledgePoint calls Qdrant when URL is set", async () => {
    setEnv("QDRANT_URL", "http://localhost:6333");
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) });

    await qdrant.upsertKnowledgePoint("id1", "How does auth work?", "JWT-based.", "docs", ["auth"], "my-repo");

    // Should have called: ensureCollection (GET), then PUT points
    expect(mockFetch).toHaveBeenCalled();
    const calls = mockFetch.mock.calls;
    const putCall = calls.find((c: any[]) => c[1]?.method === "PUT" && String(c[0]).includes("/points"));
    expect(putCall).toBeDefined();

    const body = JSON.parse(putCall![1].body);
    expect(body.points[0].payload.question).toBe("How does auth work?");
    expect(body.points[0].payload.repo).toBe("my-repo");
    expect(body.points[0].vector).toEqual([0, 0, 0, 0]);
  });

  test("upsertKnowledgePoint does not throw on fetch failure", async () => {
    setEnv("QDRANT_URL", "http://localhost:6333");
    mockFetch.mockRejectedValue(new Error("Connection refused"));

    // Should not throw
    await expect(
      qdrant.upsertKnowledgePoint("id1", "Q?", "A.", "docs", []),
    ).resolves.toBeUndefined();
  });

  test("searchSimilarQuestions returns empty without real embeddings", async () => {
    setEnv("QDRANT_URL", "http://localhost:6333");
    const result = await qdrant.searchSimilarQuestions("test question");
    expect(result).toEqual([]);
  });

  test("searchSimilarQuestions returns empty when URL not set", async () => {
    const result = await qdrant.searchSimilarQuestions("test");
    expect(result).toEqual([]);
  });

  test("getQdrantHealth returns true on ok response", async () => {
    setEnv("QDRANT_URL", "http://localhost:6333");
    mockFetch.mockResolvedValue({ ok: true });

    const healthy = await qdrant.getQdrantHealth();
    expect(healthy).toBe(true);
  });

  test("getQdrantHealth returns false when URL not set", async () => {
    const healthy = await qdrant.getQdrantHealth();
    expect(healthy).toBe(false);
  });

  test("getQdrantHealth returns false on network error", async () => {
    setEnv("QDRANT_URL", "http://localhost:6333");
    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

    const healthy = await qdrant.getQdrantHealth();
    expect(healthy).toBe(false);
  });

  test("hashToInt produces non-zero positive integer", () => {
    const hash = qdrant.hashToInt("test-id");
    expect(hash).toBeGreaterThan(0);
    expect(Number.isInteger(hash)).toBe(true);
  });
});

// ===========================================================================
// Neo4j Client
// ===========================================================================
describe("Neo4j Client", () => {
  let neo4j: typeof import("@/lib/neo4j");

  beforeEach(() => {
    jest.isolateModules(() => {
      neo4j = require("@/lib/neo4j");
    });
  });

  test("recordKnowledgeInteraction skips when NEO4J_URI not set", async () => {
    await neo4j.recordKnowledgeInteraction("u1", "q1", "ASKED");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("recordKnowledgeInteraction calls Neo4j when URI is set", async () => {
    setEnv("NEO4J_URI", "bolt://localhost:7687");
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ results: [{ columns: [], data: [] }] }),
    });

    await neo4j.recordKnowledgeInteraction("u1", "q1", "ASKED", "How does auth work?");

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/db/neo4j/tx/commit"),
      expect.objectContaining({ method: "POST" }),
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.statements[0].parameters.userId).toBe("u1");
    expect(body.statements[0].parameters.questionId).toBe("q1");
  });

  test("recordKnowledgeInteraction does not throw on failure", async () => {
    setEnv("NEO4J_URI", "bolt://localhost:7687");
    mockFetch.mockRejectedValue(new Error("Connection refused"));

    await expect(
      neo4j.recordKnowledgeInteraction("u1", "q1", "ASKED"),
    ).resolves.toBeUndefined();
  });

  test("NEO4J_URL also works as env var", async () => {
    setEnv("NEO4J_URL", "bolt://localhost:7687");
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ results: [{ columns: [], data: [] }] }),
    });

    await neo4j.recordKnowledgeInteraction("u1", "q1", "ANSWERED");
    expect(mockFetch).toHaveBeenCalled();
  });

  test("recordCollaboration creates collaboration graph", async () => {
    setEnv("NEO4J_URI", "bolt://localhost:7687");
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ results: [{ columns: [], data: [] }] }),
    });

    await neo4j.recordCollaboration("u1", "u2", "thread-1");

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.statements[0].parameters.userId1).toBe("u1");
    expect(body.statements[0].parameters.userId2).toBe("u2");
    expect(body.statements[0].parameters.threadId).toBe("thread-1");
  });

  test("recordDocGeneration creates doc graph", async () => {
    setEnv("NEO4J_URI", "bolt://localhost:7687");
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ results: [{ columns: [], data: [] }] }),
    });

    await neo4j.recordDocGeneration("u1", "doc-1", "my-repo", "src/index.ts");

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.statements[0].parameters.sourceRepo).toBe("my-repo");
    expect(body.statements[0].parameters.sourceFile).toBe("src/index.ts");
  });

  test("getKnowledgeGraph returns empty when NEO4J_URI not set", async () => {
    const result = await neo4j.getKnowledgeGraph("u1");
    expect(result).toEqual({ questions: [], documents: [], collaborators: [] });
  });

  test("getNeo4jHealth returns true on successful query", async () => {
    setEnv("NEO4J_URI", "bolt://localhost:7687");
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ results: [{ columns: ["ok"], data: [{ row: [1] }] }] }),
    });

    const healthy = await neo4j.getNeo4jHealth();
    expect(healthy).toBe(true);
  });

  test("getNeo4jHealth returns false when URI not set", async () => {
    const healthy = await neo4j.getNeo4jHealth();
    expect(healthy).toBe(false);
  });

  test("getNeo4jHealth returns false on network error", async () => {
    setEnv("NEO4J_URI", "bolt://localhost:7687");
    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

    const healthy = await neo4j.getNeo4jHealth();
    expect(healthy).toBe(false);
  });
});

// ===========================================================================
// Triple-Write Orchestrator
// ===========================================================================
describe("Triple-Write Orchestrator", () => {
  let tripleWrite: typeof import("@/lib/triple-write");

  beforeEach(() => {
    jest.isolateModules(() => {
      tripleWrite = require("@/lib/triple-write");
    });
  });

  test("tripleWriteKnowledge calls both Qdrant and Neo4j", async () => {
    setEnv("QDRANT_URL", "http://localhost:6333");
    setEnv("NEO4J_URI", "bolt://localhost:7687");
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ results: [{ columns: [], data: [] }] }),
    });

    await tripleWrite.tripleWriteKnowledge(
      "k1", "Question?", "Answer.", "docs", "u1", ["tag1"], "repo",
    );

    // Should have made calls to both Qdrant and Neo4j
    const urls = mockFetch.mock.calls.map((c: any[]) => String(c[0]));
    const hasQdrant = urls.some((u: string) => u.includes("6333"));
    const hasNeo4j = urls.some((u: string) => u.includes("7474"));
    expect(hasQdrant).toBe(true);
    expect(hasNeo4j).toBe(true);
  });

  test("tripleWriteKnowledge succeeds when one store is down", async () => {
    setEnv("QDRANT_URL", "http://localhost:6333");
    setEnv("NEO4J_URI", "bolt://localhost:7687");

    // First call (Qdrant ensureCollection) succeeds, second (Qdrant PUT) succeeds
    // Neo4j call fails
    let callCount = 0;
    mockFetch.mockImplementation(async (url: string) => {
      callCount++;
      if (String(url).includes("7474")) {
        throw new Error("Neo4j down");
      }
      return { ok: true, json: async () => ({}) };
    });

    // Should not throw even though Neo4j is down
    await expect(
      tripleWrite.tripleWriteKnowledge("k1", "Q?", "A.", "docs", "u1", []),
    ).resolves.toBeUndefined();
  });

  test("tripleWriteKnowledge succeeds when neither store is configured", async () => {
    await expect(
      tripleWrite.tripleWriteKnowledge("k1", "Q?", "A.", "docs", "u1", []),
    ).resolves.toBeUndefined();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("tripleWriteEvent fires to both stores", async () => {
    setEnv("QDRANT_URL", "http://localhost:6333");
    setEnv("NEO4J_URI", "bolt://localhost:7687");
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ results: [{ columns: [], data: [] }] }),
    });

    await tripleWrite.tripleWriteEvent({
      event_type: "knowledge.question_asked",
      user_id: "u1",
      user_role: "dev",
      metadata: { question_length: 42 },
    });

    expect(mockFetch).toHaveBeenCalled();
  });

  test("tripleWriteEvent does not throw on failure", async () => {
    setEnv("QDRANT_URL", "http://localhost:6333");
    setEnv("NEO4J_URI", "bolt://localhost:7687");
    mockFetch.mockRejectedValue(new Error("All stores down"));

    await expect(
      tripleWrite.tripleWriteEvent({
        event_type: "system.login",
        user_id: "u1",
        user_role: "dev",
        metadata: {},
      }),
    ).resolves.toBeUndefined();
  });

  test("getTripleWriteStatus returns correct booleans", async () => {
    setEnv("DATABASE_URL", "postgres://localhost/test");
    setEnv("QDRANT_URL", "http://localhost:6333");
    setEnv("NEO4J_URI", "bolt://localhost:7687");

    // Qdrant healthy, Neo4j down
    mockFetch.mockImplementation(async (url: string) => {
      if (String(url).includes("healthz")) {
        return { ok: true };
      }
      if (String(url).includes("7474")) {
        throw new Error("Neo4j down");
      }
      return { ok: true, json: async () => ({}) };
    });

    const status = await tripleWrite.getTripleWriteStatus();
    expect(status.pg).toBe(true);
    expect(status.qdrant).toBe(true);
    expect(status.neo4j).toBe(false);
  });

  test("getTripleWriteStatus returns all false when nothing configured", async () => {
    const status = await tripleWrite.getTripleWriteStatus();
    expect(status.pg).toBe(false);
    expect(status.qdrant).toBe(false);
    expect(status.neo4j).toBe(false);
  });
});

// ===========================================================================
// Knowledge.ts integration — saveAnswer triggers triple-write
// ===========================================================================
describe("Knowledge.saveAnswer triple-write integration", () => {
  test("saveAnswer triggers tripleWriteKnowledge after PG insert", async () => {
    setEnv("DATABASE_URL", "postgres://localhost/test");
    setEnv("QDRANT_URL", "http://localhost:6333");
    setEnv("NEO4J_URI", "bolt://localhost:7687");

    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: "k-new",
        question: "Test Q?",
        answer: "Test A.",
        source: "human",
        asked_by: "u1",
        repo: null,
        file_path: null,
        confidence: 0,
        rating: null,
        view_count: 0,
        tokens_used: 0,
        tags: [],
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      }],
    });

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ results: [{ columns: [], data: [] }] }),
    });

    const { saveAnswer } = require("@/lib/knowledge");
    const result = await saveAnswer("Test Q?", "Test A.", "human", "u1");

    expect(result).not.toBeNull();
    expect(result.id).toBe("k-new");

    // Wait for fire-and-forget promises
    await new Promise((r) => setTimeout(r, 50));

    // Should have called fetch for Qdrant and/or Neo4j
    expect(mockFetch).toHaveBeenCalled();
  });
});

// ===========================================================================
// Analytics.ts integration — trackEvent triggers secondary writes
// ===========================================================================
describe("Analytics.trackEvent triple-write integration", () => {
  test("analytics module imports tripleWriteEvent from triple-write", () => {
    // Verify the import wiring exists — the actual trackEvent is mocked in
    // other test suites, so here we just confirm the analytics source imports
    // the triple-write module (structural integration check).
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(
      path.join(__dirname, "../analytics.ts"),
      "utf-8",
    );
    expect(src).toContain('import { tripleWriteEvent } from "@/lib/triple-write"');
    expect(src).toContain("tripleWriteEvent(");
  });
});

// ===========================================================================
// Learning Views SQL
// ===========================================================================
describe("Learning Views SQL", () => {
  test("002_learning_views.sql exists", () => {
    const fs = require("fs");
    const path = require("path");
    const sqlPath = path.join(__dirname, "../../db/migrations/002_learning_views.sql");
    expect(fs.existsSync(sqlPath)).toBe(true);
  });

  test("002_learning_views.sql contains all 5 views", () => {
    const fs = require("fs");
    const path = require("path");
    const sqlPath = path.join(__dirname, "../../db/migrations/002_learning_views.sql");
    const sql = fs.readFileSync(sqlPath, "utf-8");

    expect(sql).toContain("v_question_to_doc_pipeline");
    expect(sql).toContain("v_automation_opportunities");
    expect(sql).toContain("v_team_expertise");
    expect(sql).toContain("v_discussion_velocity");
    expect(sql).toContain("v_product_knowledge_demand");
  });

  test("002_learning_views.sql uses CREATE OR REPLACE VIEW", () => {
    const fs = require("fs");
    const path = require("path");
    const sqlPath = path.join(__dirname, "../../db/migrations/002_learning_views.sql");
    const sql = fs.readFileSync(sqlPath, "utf-8");

    const viewCount = (sql.match(/CREATE OR REPLACE VIEW/g) || []).length;
    expect(viewCount).toBe(5);
  });
});

// ===========================================================================
// Compound Insights API shape
// ===========================================================================
describe("Compound Insights API route", () => {
  test("insights route file exists and exports GET", () => {
    const route = require("@/app/api/analytics/insights/route");
    expect(typeof route.GET).toBe("function");
  });
});
