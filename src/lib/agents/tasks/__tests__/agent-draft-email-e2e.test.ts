/**
 * End-to-end through the REAL planner + dispatcher + registry + gate + executor:
 * the terminal step of the marketing workflow ("...draft a follow-up for each")
 * must route to op_draft_email and execute POST /api/mail/draft ON THE OWNER'S
 * BEHALF, with the follow-up body chained from the prior step's output.
 *
 * Drafting (not sending) is the agent's safe action: the OGIAM gate keeps an
 * actual send escalated, but a draft has no external effect, so the agent
 * prepares it and the human reviews + sends.
 *
 * Owner-role resolver, token mint, and HTTP fetch are STUBBED; the planner,
 * dispatcher, registry, gate, operation factory, and executor are REAL.
 */

const mockRecordDecision = jest.fn((..._args: unknown[]) => Promise.resolve(null));
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

test("draft a follow-up routes to op_draft_email and POSTs /api/mail/draft on the owner's behalf", async () => {
  const mintToken = jest.fn().mockResolvedValue("onbehalf-token-draft");
  // 'ceo' holds emails.send (compose authority).
  const getOwnerRole = jest.fn().mockResolvedValue({ role: "ceo", workspaceId: "ws-1" });

  const fetchImpl = jest.fn().mockImplementation((url: string) => {
    if (url.endsWith("/api/web-search")) {
      return Promise.resolve(
        new Response(JSON.stringify({ message: "ACME is 32 days overdue on invoice INV-204." }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    if (url.endsWith("/api/mail/draft")) {
      return Promise.resolve(
        new Response(JSON.stringify({ id: "draft-1", webLink: "https://outlook/draft-1" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    return Promise.resolve(new Response("{}", { status: 404 }));
  });

  const out = await runAgentTask(
    {
      id: "task-draft",
      goal:
        "Search the web for ACME's overdue balance. Draft a follow-up to dana@acme.com about the results.",
      agentId: "agent-1",
      role: "ceo",
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

  expect(out.steps).toHaveLength(2);
  expect(out.steps[1].tool).toBe("op_draft_email");
  expect(out.steps[1].outcome).toBe("ran");
  expect(out.status).toBe("succeeded");

  const draftCall = fetchImpl.mock.calls.find((c) => (c[0] as string).endsWith("/api/mail/draft"));
  expect(draftCall).toBeTruthy();
  const init = draftCall![1] as { method: string; headers: Record<string, string>; body: string };
  expect(init.method).toBe("POST");
  expect(init.headers.Authorization).toBe("Bearer onbehalf-token-draft");
  const sent = JSON.parse(init.body);
  expect(sent.to).toBe("dana@acme.com");
  // The follow-up body was chained from the prior web-search step.
  expect(sent.bodyText).toContain("overdue");
  expect(typeof sent.subject).toBe("string");
});
