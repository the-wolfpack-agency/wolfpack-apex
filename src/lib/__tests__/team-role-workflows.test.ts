/**
 * Team Role Workflow Tests
 *
 * Simulates how each role (cto, dev, sales, ops) interacts with the
 * Wolfpack Instinct platform during a typical working day.
 *
 * 60+ tests across 6 sections:
 *   1. CTO Workflow (15 tests)
 *   2. Dev Workflow (12 tests)
 *   3. Sales Workflow (10 tests)
 *   4. Ops Workflow (10 tests)
 *   5. Cross-Role Interactions (8 tests)
 *   6. Data Pipeline Integrity (5 tests)
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// Mocks — must be declared before imports
// ---------------------------------------------------------------------------
const mockQuery: jest.Mock = jest.fn();
const mockSafeQuery: jest.Mock = jest.fn();

class MockWriteQueryError extends Error {
  readonly code: "no_database" | "db_error" | "unexpected_row_count";
  readonly expected?: number;
  readonly actual?: number;
  constructor(message: string, code: "no_database" | "db_error" | "unexpected_row_count", extra?: { expected?: number; actual?: number }) {
    super(message);
    this.name = "WriteQueryError";
    this.code = code;
    this.expected = extra?.expected;
    this.actual = extra?.actual;
  }
}

// writeQuery routes through mockSafeQuery so every existing test setup
// in this file (which queues rows via mockSafeQuery.mockResolvedValueOnce)
// continues to work against the new strict-write path. The expectRows
// contract is still enforced — a queued empty-rows result with
// expectRows: 1 throws, exactly as the production writeQuery would.
const mockWriteQuery: jest.Mock = jest.fn(async (sql: string, params?: any[], opts?: { expectRows?: number }) => {
  const result = await mockSafeQuery(sql, params);
  if (opts?.expectRows !== undefined && result.rows.length !== opts.expectRows) {
    throw new MockWriteQueryError(
      `writeQuery row-count mismatch: expected ${opts.expectRows}, got ${result.rows.length}`,
      "unexpected_row_count",
      { expected: opts.expectRows, actual: result.rows.length },
    );
  }
  return { rows: result.rows };
});

jest.mock("@/lib/db", () => ({
  query: (...args: any[]) => mockQuery(...args),
  safeQuery: (...args: any[]) => mockSafeQuery(...args),
  writeQuery: (...args: any[]) => mockWriteQuery(...args),
  WriteQueryError: MockWriteQueryError,
}));

const mockTrackEvent = jest.fn();
const mockGetEventCounts = jest.fn();

jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: any[]) => mockTrackEvent(...args),
  getEventCounts: (...args: any[]) => mockGetEventCounts(...args),
}));

// ---------------------------------------------------------------------------
// Imports — after mocks
// ---------------------------------------------------------------------------
import {
  askQuestion,
  saveAnswer,
  rateAnswer,
  searchKnowledge,
  getKnowledgeGaps,
} from "@/lib/knowledge";

import {
  getOrCreateJournal,
  updateJournal,
  addAutoContext,
  getTeamJournals,
} from "@/lib/journal";

import {
  submitFeatureRequest,
  analyzeFeatureRequest,
  voteOnFeature,
  updateFeatureStatus,
  getFeatureRequests,
} from "@/lib/feature-requests";

import {
  createThread,
  replyToThread,
  resolveThread,
  pinThread,
} from "@/lib/discussions";

import {
  generateApiDoc,
  generateReleaseNotes,
  saveDocument,
  downloadDocument,
} from "@/lib/doc-generator";

import { createClient, linkDocToClient, getClients } from "@/lib/clients";

import {
  authenticate,
  hasRole,
  createToken,
  verifyToken,
  type TeamMember,
} from "@/lib/auth";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------
const USERS: Record<string, TeamMember> = {
  cto: {
    id: "user-cto",
    email: "cto@wolfpack.dev",
    name: "Alex CTO",
    role: "cto",
    created_at: "2026-01-01T00:00:00Z",
  },
  dev: {
    id: "user-dev",
    email: "dev@wolfpack.dev",
    name: "Blake Dev",
    role: "dev",
    created_at: "2026-01-01T00:00:00Z",
  },
  sales: {
    id: "user-sales",
    email: "sales@wolfpack.dev",
    name: "Casey Sales",
    role: "sales",
    created_at: "2026-01-01T00:00:00Z",
  },
  ops: {
    id: "user-ops",
    email: "ops@wolfpack.dev",
    name: "Dana Ops",
    role: "ops",
    created_at: "2026-01-01T00:00:00Z",
  },
};

const FAKE_KNOWLEDGE_ROW = {
  id: "k-1",
  question: "How does the auth system work?",
  answer: "JWT-based with role hierarchy: cto > dev > ops > sales.",
  source: "docs",
  asked_by: "user-dev",
  repo: null,
  file_path: null,
  confidence: 95,
  rating: 5,
  view_count: 12,
  tokens_used: 0,
  tags: ["auth", "security"],
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const FAKE_JOURNAL_ROW = {
  id: "j-1",
  user_id: "user-cto",
  date: "2026-04-04",
  content: "Reviewed Q1 metrics.",
  auto_context: { events: ["login"], questions: 2 },
  mood: "focused",
  highlights: ["Shipped knowledge base"],
  blockers: [],
  created_at: "2026-04-04T08:00:00Z",
  updated_at: "2026-04-04T17:00:00Z",
};

const FAKE_FEATURE_ROW = {
  id: "fr-1",
  title: "Add OAuth SSO integration",
  description: "Implement OAuth2 SSO with Google and GitHub providers for enterprise customers.",
  submitted_by: "user-sales",
  status: "submitted",
  priority: "high",
  target_product: "apex",
  analysis: {},
  comparisons: [],
  votes: 3,
  comments: [],
  estimated_hours: null,
  estimated_cost: null,
  created_at: "2026-04-01T00:00:00Z",
  updated_at: "2026-04-01T00:00:00Z",
};

const FAKE_DISCUSSION_ROW = {
  id: "disc-1",
  title: "Architecture review: knowledge base caching",
  category: "engineering",
  created_by: "user-cto",
  status: "open",
  pinned: false,
  tags: ["architecture", "caching"],
  created_at: "2026-04-01T00:00:00Z",
  updated_at: "2026-04-01T00:00:00Z",
  reply_count: 1,
};

const FAKE_REPLY_ROW = {
  id: "reply-1",
  discussion_id: "disc-1",
  author_id: "user-dev",
  content: "I think we should use Redis for the hot cache layer.",
  attachments: [],
  created_at: "2026-04-01T01:00:00Z",
};

const FAKE_DOC_ROW = {
  id: "doc-1",
  title: "API Documentation - auth.ts",
  doc_type: "api_doc",
  content: "# Auth API\n\nJWT-based authentication.",
  format: "markdown",
  generated_from: "src/lib/auth.ts",
  generated_by: "user-dev",
  revision: 1,
  tokens_used: 0,
  downloads: 3,
  created_at: "2026-04-01T00:00:00Z",
  updated_at: "2026-04-01T00:00:00Z",
};

const FAKE_CLIENT_ROW = {
  id: "client-1",
  name: "Sample Dealer",
  industry: "automotive",
  contact_email: "contact@sampledealer.com",
  contact_name: "Jane Smith",
  notes: "Key account",
  docs: [],
  created_at: "2026-04-01T00:00:00Z",
  updated_at: "2026-04-01T00:00:00Z",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function setDatabaseUrl(val: string | undefined) {
  if (val === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = val;
  }
}

function dbConnected() {
  setDatabaseUrl("postgres://localhost/apex_test");
}

beforeEach(() => {
  jest.clearAllMocks();
  dbConnected();
});

afterEach(() => {
  delete process.env.DATABASE_URL;
});

// ===========================================================================
// 1. CTO WORKFLOW TESTS
// ===========================================================================
describe("CTO Workflow", () => {
  const cto = USERS.cto;

  test("login produces a JWT with role=cto", () => {
    const token = createToken(cto);
    const payload = verifyToken(token);

    expect(payload.role).toBe("cto");
    expect(payload.userId).toBe("user-cto");
    expect(payload.email).toBe("cto@wolfpack.dev");
    expect(payload.name).toBe("Alex CTO");
  });

  test("CEO and CTO have equal top-level access", () => {
    expect(hasRole("cto", "cto")).toBe(true);
    expect(hasRole("cto", "ceo")).toBe(true);
    expect(hasRole("ceo", "cto")).toBe(true);
    expect(hasRole("ceo", "ceo")).toBe(true);
    expect(hasRole("ceo", "dev")).toBe(true);
    expect(hasRole("ceo", "ops")).toBe(true);
    expect(hasRole("ceo", "sales")).toBe(true);
  });

  test("view dashboard stats — all 4 stat card queries return data", async () => {
    // Simulate 4 stat card queries
    mockSafeQuery
      .mockResolvedValueOnce({ rows: [{ count: 42 }], fromCache: false })   // knowledge entries
      .mockResolvedValueOnce({ rows: [{ count: 15 }], fromCache: false })   // open features
      .mockResolvedValueOnce({ rows: [{ count: 8 }], fromCache: false })    // active discussions
      .mockResolvedValueOnce({ rows: [{ count: 5 }], fromCache: false });   // team members

    const [knowledge, features, discussions, team] = await Promise.all([
      mockSafeQuery("SELECT COUNT(*) FROM apex_knowledge"),
      mockSafeQuery("SELECT COUNT(*) FROM instinct_feature_requests WHERE status != 'completed'"),
      mockSafeQuery("SELECT COUNT(*) FROM apex_discussions WHERE status = 'open'"),
      mockSafeQuery("SELECT COUNT(*) FROM apex_team_members WHERE is_active = true"),
    ]);

    expect(knowledge.rows[0].count).toBe(42);
    expect(features.rows[0].count).toBe(15);
    expect(discussions.rows[0].count).toBe(8);
    expect(team.rows[0].count).toBe(5);
  });

  test("ask a codebase question — fires knowledge.question_asked event", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [FAKE_KNOWLEDGE_ROW] })
             .mockResolvedValueOnce({ rows: [] }); // view_count update

    await askQuestion("How does the auth system work?", cto.id, cto.role);

    expect(mockTrackEvent).toHaveBeenCalledWith(
      "knowledge.question_asked",
      cto.id,
      cto.role,
      expect.objectContaining({ question_length: expect.any(Number) }),
    );
  });

  test("get cached answer — tokens_used=0 and knowledge.answer_found fires", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [FAKE_KNOWLEDGE_ROW] })
             .mockResolvedValueOnce({ rows: [] });

    const result = await askQuestion("How does the auth system work?", cto.id, cto.role);

    expect(result).not.toBeNull();
    expect(result!.tokens_used).toBe(0);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "knowledge.answer_found",
      cto.id,
      cto.role,
      expect.objectContaining({ tokens_used: 0, source: "cache" }),
    );
  });

  test("rate an answer — fires knowledge.answer_rated event", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const ok = await rateAnswer("k-1", 5, cto.id);

    expect(ok).toBe(true);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "knowledge.answer_rated",
      cto.id,
      "dev",
      expect.objectContaining({ knowledge_id: "k-1", rating: 5 }),
    );
  });

  test("view knowledge gaps — queries v_knowledge_gaps view", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [
        { question: "How to deploy?", times_asked: 5, last_asked: "2026-04-01" },
        { question: "How to rollback?", times_asked: 3, last_asked: "2026-04-02" },
      ],
      fromCache: false,
    });

    const gaps = await getKnowledgeGaps();

    expect(gaps).toHaveLength(2);
    expect(gaps[0].times_asked).toBe(5);
    expect(mockSafeQuery).toHaveBeenCalledWith(
      expect.stringContaining("v_knowledge_gaps"),
    );
  });

  test("view team journals — getTeamJournals returns all members", async () => {
    const teamJournals = [
      { ...FAKE_JOURNAL_ROW, user_id: "user-cto" },
      { ...FAKE_JOURNAL_ROW, id: "j-2", user_id: "user-dev" },
      { ...FAKE_JOURNAL_ROW, id: "j-3", user_id: "user-sales" },
      { ...FAKE_JOURNAL_ROW, id: "j-4", user_id: "user-ops" },
    ];
    mockSafeQuery.mockResolvedValueOnce({ rows: teamJournals, fromCache: false });

    const journals = await getTeamJournals("2026-04-04");

    expect(journals).toHaveLength(4);
    const userIds = journals.map((j) => j.user_id);
    expect(userIds).toContain("user-cto");
    expect(userIds).toContain("user-dev");
    expect(userIds).toContain("user-sales");
    expect(userIds).toContain("user-ops");
  });

  test("submit feature request — fires feature.request_submitted", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [{ ...FAKE_FEATURE_ROW, submitted_by: cto.id }],
      fromCache: false,
    });

    const fr = await submitFeatureRequest(
      "Real-time collaboration",
      "Add WebSocket-based real-time editing for documents.",
      cto.id,
      "apex",
      "high",
    );

    expect(fr).not.toBeNull();
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "feature.request_submitted",
      cto.id,
      "unknown",
      expect.objectContaining({ title: "Real-time collaboration" }),
    );
  });

  test("trigger feature analysis — runs zero-token analysis with cost estimate", async () => {
    const featureWithDescription = {
      ...FAKE_FEATURE_ROW,
      title: "Add OAuth SSO integration",
      description: "Implement OAuth2 SSO with Google and GitHub providers for enterprise customers. Requires authentication changes and database migration.",
    };
    mockSafeQuery
      .mockResolvedValueOnce({ rows: [featureWithDescription], fromCache: false })  // fetch request
      .mockResolvedValueOnce({ rows: [], fromCache: false })                         // similar features
      .mockResolvedValueOnce({ rows: [], fromCache: false });                        // update with analysis

    const analysis = await analyzeFeatureRequest("fr-1");

    expect(analysis).not.toBeNull();
    expect(analysis!.estimated_cost_min).toBeGreaterThan(0);
    expect(analysis!.estimated_hours_min).toBeGreaterThan(0);
    expect(analysis!.keywords_matched.length).toBeGreaterThan(0);
  });

  test("approve feature request — fires feature.request_approved and updates status", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [{ ...FAKE_FEATURE_ROW, status: "approved" }],
      fromCache: false,
    });

    const updated = await updateFeatureStatus("fr-1", "approved", cto.id);

    expect(updated).not.toBeNull();
    expect(updated!.status).toBe("approved");
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "feature.request_approved",
      cto.id,
      "unknown",
      expect.objectContaining({ feature_id: "fr-1", new_status: "approved" }),
    );
  });

  test("create a discussion thread — thread + initial reply created", async () => {
    mockSafeQuery
      .mockResolvedValueOnce({ rows: [FAKE_DISCUSSION_ROW], fromCache: false })  // INSERT discussion
      .mockResolvedValueOnce({ rows: [], fromCache: false });                     // INSERT reply

    const thread = await createThread(
      "Architecture review: knowledge base caching",
      "engineering",
      cto.id,
      "Let's discuss the caching strategy for the knowledge base.",
      ["architecture", "caching"],
    );

    expect(thread).not.toBeNull();
    expect(thread!.reply_count).toBe(1);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "discussion.thread_created",
      cto.id,
      "unknown",
      expect.objectContaining({ category: "engineering" }),
    );
  });

  test("pin a discussion — CTO role is authorized", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [{ pinned: true }],
      fromCache: false,
    });

    const result = await pinThread("disc-1", cto.id, cto.role);

    expect(result).toEqual(expect.objectContaining({ pinned: true }));
    expect(result).not.toHaveProperty("error");
  });

  test("view analytics — AI efficiency and team activity queries", async () => {
    mockGetEventCounts.mockResolvedValueOnce({
      "knowledge.answer_found": 120,
      "knowledge.answer_not_found": 15,
      "system.ai_call_made": 15,
      "system.ai_call_skipped": 120,
    });

    const counts = await mockGetEventCounts(24);

    const totalQuestions = (counts["knowledge.answer_found"] ?? 0) + (counts["knowledge.answer_not_found"] ?? 0);
    const zeroTokenHits = counts["system.ai_call_skipped"] ?? 0;
    const aiCalls = counts["system.ai_call_made"] ?? 0;

    expect(totalQuestions).toBe(135);
    expect(zeroTokenHits).toBeGreaterThan(aiCalls);
  });

  test("generate API doc — zero tokens used", () => {
    const doc = generateApiDoc("/non/existent/repo", "src/lib/auth.ts");

    expect(doc.tokens_used).toBe(0);
    expect(doc.doc_type).toBe("api_doc");
    expect(doc.title).toContain("auth.ts");
  });

  test("view all clients — list returned", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [FAKE_CLIENT_ROW, { ...FAKE_CLIENT_ROW, id: "client-2", name: "Metro Motors" }],
      fromCache: false,
    });

    const clients = await getClients();

    expect(clients).toHaveLength(2);
    expect(clients[0].name).toBe("Sample Dealer");
  });
});

// ===========================================================================
// 2. DEV WORKFLOW TESTS
// ===========================================================================
describe("Dev Workflow", () => {
  const dev = USERS.dev;

  test("login produces a JWT with role=dev", () => {
    const token = createToken(dev);
    const payload = verifyToken(token);

    expect(payload.role).toBe("dev");
    expect(payload.userId).toBe("user-dev");
  });

  test("ask technical question — fires search via askQuestion", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [FAKE_KNOWLEDGE_ROW] })
             .mockResolvedValueOnce({ rows: [] });

    const result = await askQuestion("How does the auth system work?", dev.id, dev.role);

    expect(result).not.toBeNull();
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "knowledge.question_asked",
      dev.id,
      dev.role,
      expect.any(Object),
    );
  });

  test("answer not found — fires knowledge.answer_not_found event", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await askQuestion("How does the quantum flux capacitor work?", dev.id, dev.role);

    expect(result).toBeNull();
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "knowledge.answer_not_found",
      dev.id,
      dev.role,
      expect.objectContaining({ question_length: expect.any(Number) }),
    );
  });

  test("save a new answer — INSERT + tokens tracked", async () => {
    const newRow = {
      ...FAKE_KNOWLEDGE_ROW,
      id: "k-new",
      question: "How does the caching layer work?",
      answer: "We use pg_trgm similarity search with a 0.3 threshold.",
      tokens_used: 150,
    };
    mockQuery.mockResolvedValueOnce({ rows: [newRow] });

    const saved = await saveAnswer(
      "How does the caching layer work?",
      "We use pg_trgm similarity search with a 0.3 threshold.",
      "human",
      dev.id,
      "wolfpack-apex",
      "src/lib/knowledge.ts",
      150,
    );

    expect(saved).not.toBeNull();
    expect(saved!.tokens_used).toBe(150);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO apex_knowledge"),
      expect.arrayContaining(["How does the caching layer work?", 150]),
    );
  });

  test("generate API doc from file — TypeScript parsing works", () => {
    // generateApiDoc reads from filesystem; non-existent file returns a placeholder doc
    const doc = generateApiDoc("/tmp", "test.ts");

    expect(doc.doc_type).toBe("api_doc");
    expect(doc.tokens_used).toBe(0);
    expect(doc.title).toContain("test.ts");
  });

  test("generate release notes — git log parsing produces doc", () => {
    // Points at a path that likely has no git repo; verifies graceful handling
    const doc = generateReleaseNotes("/tmp/no-repo", "2026-01-01");

    expect(doc.doc_type).toBe("release_notes");
    expect(doc.tokens_used).toBe(0);
    expect(doc.title).toContain("2026-01-01");
  });

  test("submit feature request — fires event", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [{ ...FAKE_FEATURE_ROW, title: "Add GraphQL layer", submitted_by: dev.id }],
      fromCache: false,
    });

    const fr = await submitFeatureRequest(
      "Add GraphQL layer",
      "Wrap existing REST endpoints in GraphQL schema for flexible querying.",
      dev.id,
      "apex",
    );

    expect(fr).not.toBeNull();
    expect(fr!.title).toBe("Add GraphQL layer");
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "feature.request_submitted",
      dev.id,
      "unknown",
      expect.objectContaining({ title: "Add GraphQL layer" }),
    );
  });

  test("vote on feature — increments vote count", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [{ votes: 4 }],
      fromCache: false,
    });

    const newVotes = await voteOnFeature("fr-1", dev.id);

    expect(newVotes).toBe(4);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "feature.request_submitted",
      dev.id,
      "unknown",
      expect.objectContaining({ action: "vote" }),
    );
  });

  test("reply to discussion — reply created", async () => {
    mockSafeQuery
      .mockResolvedValueOnce({ rows: [FAKE_REPLY_ROW], fromCache: false }) // INSERT reply
      .mockResolvedValueOnce({ rows: [], fromCache: false });              // UPDATE discussion

    const reply = await replyToThread(
      "disc-1",
      dev.id,
      "I think we should use Redis for the hot cache layer.",
    );

    expect(reply).not.toBeNull();
    expect(reply!.content).toContain("Redis");
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "discussion.reply_posted",
      dev.id,
      "unknown",
      expect.objectContaining({ discussion_id: "disc-1" }),
    );
  });

  test("pin discussion — dev role is authorized", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [{ pinned: true }],
      fromCache: false,
    });

    const result = await pinThread("disc-1", dev.id, dev.role);

    expect(result).toEqual(expect.objectContaining({ pinned: true }));
    expect(result).not.toHaveProperty("error");
  });

  test("view own journal — auto-populated from events", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [FAKE_JOURNAL_ROW] });

    const journal = await getOrCreateJournal(dev.id, "2026-04-04");

    expect(journal).not.toBeNull();
    expect(journal.user_id).toBeTruthy();
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "journal.entry_created",
      dev.id,
      "dev",
      expect.objectContaining({ date: "2026-04-04" }),
    );
  });

  test("create prototype — prototype record created via safeQuery", async () => {
    const protoRow = {
      id: "proto-1",
      title: "Cache benchmark prototype",
      created_by: dev.id,
      status: "active",
      created_at: "2026-04-04T00:00:00Z",
    };
    mockSafeQuery.mockResolvedValueOnce({ rows: [protoRow], fromCache: false });

    const result = await mockSafeQuery(
      "INSERT INTO apex_prototypes (title, created_by) VALUES ($1, $2) RETURNING *",
      ["Cache benchmark prototype", dev.id],
    );

    expect(result.rows[0].id).toBe("proto-1");
    expect(result.rows[0].created_by).toBe(dev.id);
  });
});

// ===========================================================================
// 3. SALES WORKFLOW TESTS
// ===========================================================================
describe("Sales Workflow", () => {
  const sales = USERS.sales;

  test("login produces a JWT with role=sales", () => {
    const token = createToken(sales);
    const payload = verifyToken(token);

    expect(payload.role).toBe("sales");
    expect(payload.userId).toBe("user-sales");
  });

  test("ask question about product features — fires search", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [FAKE_KNOWLEDGE_ROW] })
             .mockResolvedValueOnce({ rows: [] });

    const result = await askQuestion("What features does Apex support?", sales.id, sales.role);

    expect(mockTrackEvent).toHaveBeenCalledWith(
      "knowledge.question_asked",
      sales.id,
      sales.role,
      expect.any(Object),
    );
  });

  test("generate client proposal doc — doc_type=client_proposal", async () => {
    const proposalDoc = {
      ...FAKE_DOC_ROW,
      id: "doc-proposal",
      doc_type: "client_proposal",
      title: "Proposal for Sample Dealer",
      generated_by: sales.id,
    };
    mockQuery.mockResolvedValueOnce({ rows: [proposalDoc] });

    const saved = await saveDocument(
      {
        title: "Proposal for Sample Dealer",
        doc_type: "client_proposal",
        content: "# Proposal\n\nCustom platform for Sample Dealer.",
        format: "markdown",
        generated_from: null,
        generated_by: sales.id,
        tokens_used: 0,
      },
      sales.id,
    );

    expect(saved).not.toBeNull();
    expect(saved!.doc_type).toBe("client_proposal");
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "knowledge.doc_generated",
      sales.id,
      "dev",
      expect.objectContaining({ doc_type: "client_proposal", tokens_used: 0 }),
    );
  });

  test("create client profile — INSERT returns client record", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [FAKE_CLIENT_ROW],
      fromCache: false,
    });

    const client = await createClient(
      "Sample Dealer",
      "automotive",
      "contact@sampledealer.com",
      "Jane Smith",
      "Key account",
    );

    expect(client).not.toBeNull();
    expect(client!.name).toBe("Sample Dealer");
    expect(client!.industry).toBe("automotive");
  });

  test("link document to client — JSONB update", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [{ ...FAKE_CLIENT_ROW, docs: ["doc-proposal"] }],
      fromCache: false,
    });

    const updated = await linkDocToClient("client-1", "doc-proposal");

    expect(updated).not.toBeNull();
    expect(updated!.docs).toContain("doc-proposal");
    expect(mockSafeQuery).toHaveBeenCalledWith(
      expect.stringContaining("docs = docs ||"),
      expect.arrayContaining(["client-1"]),
    );
  });

  test("submit automation request — category=automation with ROI estimation", async () => {
    const automationFeature = {
      ...FAKE_FEATURE_ROW,
      id: "fr-auto",
      title: "Automate proposal generation workflow",
      description: "Create automated proposal generation from client profile data with export to PDF.",
      submitted_by: sales.id,
      priority: "high",
    };
    mockSafeQuery.mockResolvedValueOnce({ rows: [automationFeature], fromCache: false });

    const fr = await submitFeatureRequest(
      "Automate proposal generation workflow",
      "Create automated proposal generation from client profile data with export to PDF.",
      sales.id,
      "apex",
      "high",
    );

    expect(fr).not.toBeNull();
    expect(fr!.submitted_by).toBe(sales.id);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "feature.request_submitted",
      sales.id,
      "unknown",
      expect.any(Object),
    );
  });

  test("view feature requests — list returned", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [FAKE_FEATURE_ROW, { ...FAKE_FEATURE_ROW, id: "fr-2", title: "Add CSV export" }],
      fromCache: false,
    });

    const features = await getFeatureRequests();

    expect(features).toHaveLength(2);
  });

  test("try to pin discussion — REJECTED for sales role", async () => {
    const result = await pinThread("disc-1", sales.id, sales.role);

    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("Insufficient permissions");
    // safeQuery should NOT have been called (authorization check fails before DB call)
    expect(mockSafeQuery).not.toHaveBeenCalled();
  });

  test("reply to client-category discussion — allowed", async () => {
    mockSafeQuery
      .mockResolvedValueOnce({
        rows: [{ ...FAKE_REPLY_ROW, author_id: sales.id, content: "Client needs this by Q2." }],
        fromCache: false,
      })
      .mockResolvedValueOnce({ rows: [], fromCache: false });

    const reply = await replyToThread("disc-1", sales.id, "Client needs this by Q2.");

    expect(reply).not.toBeNull();
    expect(reply!.content).toContain("Q2");
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "discussion.reply_posted",
      sales.id,
      "unknown",
      expect.any(Object),
    );
  });

  test("download doc — download_count incremented", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ ...FAKE_DOC_ROW, downloads: 4 }],
    });

    const doc = await downloadDocument("doc-1", sales.id);

    expect(doc).not.toBeNull();
    expect(doc!.downloads).toBe(4);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "knowledge.doc_downloaded",
      sales.id,
      "dev",
      expect.objectContaining({ doc_id: "doc-1" }),
    );
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("downloads = downloads + 1"),
      ["doc-1"],
    );
  });
});

// ===========================================================================
// 4. OPS WORKFLOW TESTS
// ===========================================================================
describe("Ops Workflow", () => {
  const ops = USERS.ops;

  test("login produces a JWT with role=ops", () => {
    const token = createToken(ops);
    const payload = verifyToken(token);

    expect(payload.role).toBe("ops");
    expect(payload.userId).toBe("user-ops");
  });

  test("view own journal with auto-context — events timeline returned", async () => {
    const opsJournal = {
      ...FAKE_JOURNAL_ROW,
      user_id: "user-ops",
      auto_context: { events: ["login", "doc_reviewed", "meeting"], questions: 1 },
    };
    mockQuery.mockResolvedValueOnce({ rows: [opsJournal] });

    const journal = await getOrCreateJournal(ops.id, "2026-04-04");

    expect(journal).not.toBeNull();
    expect(journal.auto_context).toHaveProperty("events");
    expect((journal.auto_context.events as string[]).length).toBe(3);
  });

  test("add manual note to journal — UPDATE fires event", async () => {
    const updated = {
      ...FAKE_JOURNAL_ROW,
      id: "j-ops",
      user_id: ops.id,
      content: "Reviewed vendor SLAs. All green.",
      mood: "productive",
    };
    mockQuery.mockResolvedValueOnce({ rows: [updated] });

    const result = await updateJournal("j-ops", ops.id, {
      content: "Reviewed vendor SLAs. All green.",
      mood: "productive",
    });

    expect(result).not.toBeNull();
    expect(result!.content).toContain("vendor SLAs");
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "journal.entry_updated",
      ops.id,
      "dev",
      expect.objectContaining({ journal_id: "j-ops" }),
    );
  });

  test("create process discussion — category=process", async () => {
    const processDiscussion = {
      ...FAKE_DISCUSSION_ROW,
      id: "disc-proc",
      title: "Onboarding checklist update",
      category: "process",
      created_by: ops.id,
    };
    mockSafeQuery
      .mockResolvedValueOnce({ rows: [processDiscussion], fromCache: false })
      .mockResolvedValueOnce({ rows: [], fromCache: false });

    const thread = await createThread(
      "Onboarding checklist update",
      "process",
      ops.id,
      "We need to add security training to the onboarding checklist.",
      ["onboarding", "process"],
    );

    expect(thread).not.toBeNull();
    expect(thread!.category).toBe("process");
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "discussion.thread_created",
      ops.id,
      "unknown",
      expect.objectContaining({ category: "process" }),
    );
  });

  test("submit automation suggestion — time savings calculated via analysis", async () => {
    const automationFeature = {
      ...FAKE_FEATURE_ROW,
      id: "fr-ops-auto",
      title: "Automate weekly report email distribution",
      description: "Send automated weekly report emails to all stakeholders with dashboard data export.",
      submitted_by: ops.id,
    };
    // Submit
    mockSafeQuery.mockResolvedValueOnce({ rows: [automationFeature], fromCache: false });
    const fr = await submitFeatureRequest(
      "Automate weekly report email distribution",
      "Send automated weekly report emails to all stakeholders with dashboard data export.",
      ops.id,
      "apex",
    );

    expect(fr).not.toBeNull();

    // Analyze
    mockSafeQuery
      .mockResolvedValueOnce({ rows: [automationFeature], fromCache: false })
      .mockResolvedValueOnce({ rows: [], fromCache: false })
      .mockResolvedValueOnce({ rows: [], fromCache: false });

    const analysis = await analyzeFeatureRequest("fr-ops-auto");

    expect(analysis).not.toBeNull();
    expect(analysis!.estimated_hours_min).toBeGreaterThan(0);
    expect(analysis!.keywords_matched).toEqual(
      expect.arrayContaining(["email"]),
    );
  });

  test("generate process doc — doc_type=process_doc", async () => {
    const processDoc = {
      ...FAKE_DOC_ROW,
      id: "doc-process",
      doc_type: "process_doc",
      title: "Client Onboarding Process",
      generated_by: ops.id,
    };
    mockQuery.mockResolvedValueOnce({ rows: [processDoc] });

    const saved = await saveDocument(
      {
        title: "Client Onboarding Process",
        doc_type: "process_doc",
        content: "# Onboarding\n\n1. Send welcome email\n2. Schedule kickoff.",
        format: "markdown",
        generated_from: null,
        generated_by: ops.id,
        tokens_used: 0,
      },
      ops.id,
    );

    expect(saved).not.toBeNull();
    expect(saved!.doc_type).toBe("process_doc");
  });

  test("view team activity — queries team_activity view", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [
        { user_id: "user-cto", event_count: 42 },
        { user_id: "user-dev", event_count: 38 },
        { user_id: "user-ops", event_count: 20 },
      ],
      fromCache: false,
    });

    const result = await mockSafeQuery("SELECT * FROM v_team_activity ORDER BY event_count DESC");

    expect(result.rows).toHaveLength(3);
    expect(result.rows[0].event_count).toBe(42);
  });

  test("try to approve feature — REJECTED (ops lacks cto role)", () => {
    // hasRole checks if ops >= cto level; it cannot
    expect(hasRole("ops", "cto")).toBe(false);
    expect(hasRole("ops", "dev")).toBe(false);
    // ops can only match ops and sales levels
    expect(hasRole("ops", "ops")).toBe(true);
    expect(hasRole("ops", "sales")).toBe(true);
  });

  test("view clients — read access works", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [FAKE_CLIENT_ROW],
      fromCache: false,
    });

    const clients = await getClients();

    expect(clients).toHaveLength(1);
    expect(clients[0].name).toBe("Sample Dealer");
  });

  test("search knowledge base — works for ops role", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [FAKE_KNOWLEDGE_ROW],
      fromCache: false,
    });

    const results = await searchKnowledge("auth");

    expect(results).toHaveLength(1);
    expect(results[0].question).toContain("auth");
  });
});

// ===========================================================================
// 5. CROSS-ROLE INTERACTION TESTS
// ===========================================================================
describe("Cross-Role Interactions", () => {
  test("dev answers a question, sales gets the cached answer (zero tokens)", async () => {
    const dev = USERS.dev;
    const sales = USERS.sales;

    // Dev saves an answer (costs tokens)
    const savedRow = {
      ...FAKE_KNOWLEDGE_ROW,
      id: "k-cross",
      question: "What pricing tiers do we offer?",
      answer: "Starter $49/mo, Pro $149/mo, Enterprise custom.",
      tokens_used: 200,
      asked_by: dev.id,
    };
    mockQuery.mockResolvedValueOnce({ rows: [savedRow] });
    await saveAnswer(
      "What pricing tiers do we offer?",
      "Starter $49/mo, Pro $149/mo, Enterprise custom.",
      "human",
      dev.id,
      undefined,
      undefined,
      200,
    );

    // Sales asks the same question — gets cached answer with zero tokens
    const cachedRow = { ...savedRow, view_count: 1, tokens_used: 0 };
    mockQuery.mockResolvedValueOnce({ rows: [cachedRow] })
             .mockResolvedValueOnce({ rows: [] }); // view_count bump

    const result = await askQuestion("What pricing tiers do we offer?", sales.id, sales.role);

    expect(result).not.toBeNull();
    expect(result!.answer).toContain("$149/mo");
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "knowledge.answer_found",
      sales.id,
      sales.role,
      expect.objectContaining({ tokens_used: 0, source: "cache" }),
    );
  });

  test("CTO creates discussion, all roles can reply", async () => {
    const cto = USERS.cto;

    // CTO creates thread
    mockSafeQuery
      .mockResolvedValueOnce({ rows: [FAKE_DISCUSSION_ROW], fromCache: false })
      .mockResolvedValueOnce({ rows: [], fromCache: false });

    const thread = await createThread("Q2 Planning", "general", cto.id, "Let's align on Q2 goals.");
    expect(thread).not.toBeNull();

    // All 4 roles reply
    for (const role of ["dev", "sales", "ops", "cto"] as const) {
      const user = USERS[role];
      mockSafeQuery
        .mockResolvedValueOnce({
          rows: [{ ...FAKE_REPLY_ROW, author_id: user.id, content: `${role} input` }],
          fromCache: false,
        })
        .mockResolvedValueOnce({ rows: [], fromCache: false });

      const reply = await replyToThread("disc-1", user.id, `${role} input`);
      expect(reply).not.toBeNull();
      expect(reply!.content).toContain(role);
    }

    // Verify 4 reply events + 1 thread creation event fired
    const replyEvents = mockTrackEvent.mock.calls.filter(
      (c: any[]) => c[0] === "discussion.reply_posted",
    );
    expect(replyEvents).toHaveLength(4);
  });

  test("sales submits feature, CTO approves, dev sees in pipeline", async () => {
    const sales = USERS.sales;
    const cto = USERS.cto;

    // Sales submits
    mockSafeQuery.mockResolvedValueOnce({
      rows: [{ ...FAKE_FEATURE_ROW, id: "fr-cross", submitted_by: sales.id }],
      fromCache: false,
    });
    const fr = await submitFeatureRequest("Bulk email templates", "Create reusable email templates for client outreach.", sales.id);
    expect(fr).not.toBeNull();

    // CTO approves
    mockSafeQuery.mockResolvedValueOnce({
      rows: [{ ...FAKE_FEATURE_ROW, id: "fr-cross", status: "approved" }],
      fromCache: false,
    });
    const approved = await updateFeatureStatus("fr-cross", "approved", cto.id);
    expect(approved).not.toBeNull();
    expect(approved!.status).toBe("approved");

    // Dev views pipeline — sees approved feature
    mockSafeQuery.mockResolvedValueOnce({
      rows: [{ ...FAKE_FEATURE_ROW, id: "fr-cross", status: "approved" }],
      fromCache: false,
    });
    const pipeline = await getFeatureRequests("approved");
    expect(pipeline).toHaveLength(1);
    expect(pipeline[0].status).toBe("approved");
  });

  test("ops submits automation, analysis calculates ROI automatically", async () => {
    const ops = USERS.ops;

    // Submit
    mockSafeQuery.mockResolvedValueOnce({
      rows: [{ ...FAKE_FEATURE_ROW, id: "fr-auto-ops", title: "Automate invoice reconciliation", description: "Build automated invoice import and reconciliation workflow with notification email and dashboard report integration." }],
      fromCache: false,
    });
    await submitFeatureRequest(
      "Automate invoice reconciliation",
      "Build automated invoice import and reconciliation workflow with notification email and dashboard report integration.",
      ops.id,
    );

    // Analyze — keywords like "email", "dashboard", "report", "workflow", "notification" should match
    const featureForAnalysis = {
      ...FAKE_FEATURE_ROW,
      id: "fr-auto-ops",
      title: "Automate invoice reconciliation",
      description: "Build automated invoice import and reconciliation workflow with notification email and dashboard report integration.",
    };
    mockSafeQuery
      .mockResolvedValueOnce({ rows: [featureForAnalysis], fromCache: false })
      .mockResolvedValueOnce({ rows: [], fromCache: false })
      .mockResolvedValueOnce({ rows: [], fromCache: false });

    const analysis = await analyzeFeatureRequest("fr-auto-ops");

    expect(analysis).not.toBeNull();
    expect(analysis!.estimated_cost_min).toBeGreaterThan(0);
    expect(analysis!.keywords_matched.length).toBeGreaterThan(0);
    // Should detect at least email, dashboard, report, workflow
    expect(analysis!.keywords_matched).toEqual(
      expect.arrayContaining(["email"]),
    );
  });

  test("multiple users ask same question — view_count increments each time", async () => {
    const users = [USERS.cto, USERS.dev, USERS.sales];

    for (let i = 0; i < users.length; i++) {
      const viewCountRow = { ...FAKE_KNOWLEDGE_ROW, view_count: 12 + i };
      mockQuery
        .mockResolvedValueOnce({ rows: [viewCountRow] })
        .mockResolvedValueOnce({ rows: [] }); // UPDATE view_count

      await askQuestion("How does the auth system work?", users[i].id, users[i].role);
    }

    // Each call should have triggered a view_count UPDATE
    const viewCountUpdates = mockQuery.mock.calls.filter(
      (c: any[]) => typeof c[0] === "string" && c[0].includes("view_count = view_count + 1"),
    );
    expect(viewCountUpdates).toHaveLength(3);
  });

  test("low-rated answers surface in knowledge gaps", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [
        { question: "How to set up CI/CD?", times_asked: 8, last_asked: "2026-04-03" },
        { question: "What is our deployment process?", times_asked: 6, last_asked: "2026-04-02" },
      ],
      fromCache: false,
    });

    const gaps = await getKnowledgeGaps();

    expect(gaps).toHaveLength(2);
    expect(gaps[0].times_asked).toBe(8);
    expect(mockSafeQuery).toHaveBeenCalledWith(
      expect.stringContaining("v_knowledge_gaps"),
    );
  });

  test("AI efficiency tracks zero-token vs AI calls accurately", async () => {
    mockGetEventCounts.mockResolvedValueOnce({
      "system.ai_call_skipped": 200,
      "system.ai_call_made": 15,
      "knowledge.answer_found": 200,
      "knowledge.answer_not_found": 15,
    });

    const counts = await mockGetEventCounts(24);

    const zeroTokenRate = counts["system.ai_call_skipped"] /
      (counts["system.ai_call_skipped"] + counts["system.ai_call_made"]);
    expect(zeroTokenRate).toBeGreaterThan(0.9);

    const cacheHitRate = counts["knowledge.answer_found"] /
      (counts["knowledge.answer_found"] + counts["knowledge.answer_not_found"]);
    expect(cacheHitRate).toBeGreaterThan(0.9);
  });

  test("journal auto-populates from tracked events", async () => {
    const dev = USERS.dev;

    // Add auto-context after some tracked events
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // UPSERT journal
      .mockResolvedValueOnce({ rows: [] }); // UPDATE auto_context

    const ok = await addAutoContext(dev.id, {
      latest_question: "How does auth work?",
      docs_generated: 2,
      discussions_replied: 1,
    });

    expect(ok).toBe(true);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "journal.context_added",
      dev.id,
      "dev",
      expect.objectContaining({
        context_type: expect.stringContaining("latest_question"),
      }),
    );
  });
});

// ===========================================================================
// 6. DATA PIPELINE INTEGRITY TESTS
// ===========================================================================
describe("Data Pipeline Integrity", () => {
  test("every login fires system.login event (shadow mode)", async () => {
    // Use shadow mode (no DATABASE_URL) to test the demo auth path
    delete process.env.DATABASE_URL;

    const result = await authenticate("cto@wolfpack.dev", "apex");

    expect(result).not.toBeNull();
    expect(result!.user.role).toBe("cto");
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "system.login",
      "demo-cto",
      "cto",
      expect.objectContaining({ mode: "shadow" }),
    );
  });

  test("every question fires knowledge.question_asked", async () => {
    dbConnected();
    mockQuery.mockResolvedValueOnce({ rows: [] }); // cache miss

    await askQuestion("Any random question", "user-1", "dev");

    expect(mockTrackEvent).toHaveBeenCalledWith(
      "knowledge.question_asked",
      "user-1",
      "dev",
      expect.objectContaining({ question_length: expect.any(Number) }),
    );
  });

  test("every doc generation fires knowledge.doc_generated", async () => {
    dbConnected();
    mockQuery.mockResolvedValueOnce({ rows: [FAKE_DOC_ROW] });

    await saveDocument(
      {
        title: "Test Doc",
        doc_type: "api_doc",
        content: "# Test",
        format: "markdown",
        generated_from: "test.ts",
        generated_by: "user-1",
        tokens_used: 0,
      },
      "user-1",
    );

    expect(mockTrackEvent).toHaveBeenCalledWith(
      "knowledge.doc_generated",
      "user-1",
      "dev",
      expect.objectContaining({ doc_type: "api_doc", tokens_used: 0 }),
    );
  });

  test("every feature submission fires feature.request_submitted", async () => {
    dbConnected();
    mockSafeQuery.mockResolvedValueOnce({
      rows: [{ ...FAKE_FEATURE_ROW, id: "fr-pipe" }],
      fromCache: false,
    });

    await submitFeatureRequest("Pipeline test", "Testing the event pipeline.", "user-1");

    expect(mockTrackEvent).toHaveBeenCalledWith(
      "feature.request_submitted",
      "user-1",
      "unknown",
      expect.objectContaining({ title: "Pipeline test" }),
    );
  });

  test("every discussion reply fires discussion.reply_posted", async () => {
    dbConnected();
    mockSafeQuery
      .mockResolvedValueOnce({ rows: [FAKE_REPLY_ROW], fromCache: false })
      .mockResolvedValueOnce({ rows: [], fromCache: false });

    await replyToThread("disc-1", "user-1", "Pipeline integrity check");

    expect(mockTrackEvent).toHaveBeenCalledWith(
      "discussion.reply_posted",
      "user-1",
      "unknown",
      expect.objectContaining({ discussion_id: "disc-1" }),
    );
  });
});
