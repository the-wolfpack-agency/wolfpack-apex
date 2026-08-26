/**
 * End-to-end through the REAL planner + dispatcher + registry + gate + executor:
 * the exact two-step instruction a user ran in production,
 *
 *   "Scan the internet for the latest news on auto SAAS companies.
 *    Create a document summary of the results."
 *
 * must decompose into two governed steps: step 1 routes to op_web_search, step 2
 * routes to op_create_document (previously NO tool matched it -> the "no_match"
 * the user reported). Step 2's body is filled by RESULT CHAINING from step 1's
 * output, and the executor invokes POST /api/knowledge ON THE OWNER'S BEHALF.
 *
 * The owner-role resolver, the token mint, and the HTTP fetch are STUBBED (no db,
 * no signing, no network); the planner, dispatcher, registry, OGIAM gate, the
 * operation tool factory, and the executor are REAL.
 */

const mockRecordDecision = jest.fn((..._args: unknown[]) => Promise.resolve({ id: "d_test", seq: 1, entryHash: "h" }));
jest.mock("@/lib/ogiam/ledger", () => ({
  ...jest.requireActual("@/lib/ogiam/ledger"),
  recordDecision: (...a: unknown[]) => mockRecordDecision(...a),
}));
jest.mock("@/lib/analytics", () => ({ trackEvent: jest.fn() }));
jest.mock("@/lib/db", () => ({
  safeQuery: jest.fn(() => Promise.resolve({ rows: [] })),
  writeQuery: jest.fn(() => Promise.resolve({ rows: [] })),
}));

import "@/lib/assistant/tools";
import { runAgentTask } from "@/lib/agents/tasks/executor";

/* Containment gate: these suites exercise the executor's own behaviour, not the
   stop or the budget, so they declare an enabled workspace with a fresh ledger.
   Saying it out loud beats a gate that silently does not apply — the executor
   fails closed by design, and a suite that did not opt in would be testing the
   refusal path without meaning to. Containment itself is covered in
   src/lib/containment/__tests__. */
import { _setContainmentStateForTests, _setRunSpendForTests } from "@/lib/containment/state";
import { _setCeilingForTests, CEILING_NOT_UNDER_TEST } from "@/lib/agents/ceiling";
beforeEach(() => {
  _setContainmentStateForTests({ agentsEnabled: true, readable: true });
  _setRunSpendForTests({ tokens: 0, durationMs: 0, egressCalls: 0, spendCents: 0 });
  _setCeilingForTests(CEILING_NOT_UNDER_TEST);
});
afterAll(() => {
  _setContainmentStateForTests(null);
  _setRunSpendForTests(null);
  _setCeilingForTests(null);
});


test("search -> document decomposes, chains the result into the body, and creates the doc on the owner's behalf", async () => {
  const mintToken = jest.fn().mockResolvedValue("onbehalf-token-doc");
  // 'dev' holds knowledge.search, so the gate allows the create_document op.
  const getOwnerRole = jest.fn().mockResolvedValue({ role: "dev", workspaceId: "ws-1" });

  // Route the on-behalf fetch by path: the web search returns a summary message
  // (which becomes the carried prior result), the knowledge create returns 201.
  const fetchImpl = jest.fn().mockImplementation((url: string) => {
    if (url.endsWith("/api/web-search")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ message: "Found 3 recent articles on auto SAAS companies." }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    if (url.endsWith("/api/knowledge")) {
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, entry: { id: "k-1" } }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    return Promise.resolve(new Response("{}", { status: 404 }));
  });

  const out = await runAgentTask(
    {
      id: "task-doc",
      goal: "Scan the internet for the latest news on auto SAAS companies. Create a document summary of the results.",
      agentId: "agent-1",
      role: "dev",
      workspaceId: "ws-1",
      ownerUserId: "owner-9",
    },
    {
      lookupProcedure: (async () => null) as never,
      recordProcedure: (async () => null) as never,
      ground: (async () => ({ used: false, hits: 0, snippets: [] })) as never,
      getOwnerRole: getOwnerRole as never,
      mintToken: mintToken as never,
      origin: (() => "https://internal.example") as never,
      fetchImpl: fetchImpl as never,
    },
  );

  // Two governed steps, both ran. Step 2 is no longer a no_match.
  expect(out.steps).toHaveLength(2);
  expect(out.steps[0].tool).toBe("op_web_search");
  expect(out.steps[0].outcome).toBe("ran");
  expect(out.steps[1].tool).toBe("op_create_document");
  expect(out.steps[1].outcome).toBe("ran");
  expect(out.status).toBe("succeeded");

  // Both on-behalf calls hit their routes with a Bearer token.
  const calls = fetchImpl.mock.calls.map((c) => c[0] as string);
  expect(calls).toEqual([
    "https://internal.example/api/web-search",
    "https://internal.example/api/knowledge",
  ]);

  // The document body was filled by RESULT CHAINING from the web-search output,
  // the title was derived from the instruction, and provenance is marked agent.
  const knowledgeCall = fetchImpl.mock.calls.find((c) =>
    (c[0] as string).endsWith("/api/knowledge"),
  );
  const body = JSON.parse((knowledgeCall![1] as { body: string }).body);
  expect(body.question).toBe("Document summary of the results");
  expect(body.answer).toContain("auto SAAS companies");
  expect(body.source).toBe("agent");
  expect((knowledgeCall![1] as { headers: Record<string, string> }).headers.Authorization).toBe(
    "Bearer onbehalf-token-doc",
  );
});
