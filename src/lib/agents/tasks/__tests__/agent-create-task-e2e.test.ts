/**
 * End-to-end through the REAL dispatcher + registry + gate + executor: an agent
 * assigned "add a task titled Demo" must route to create_task_form, have its
 * form auto-filled, and execute on behalf of its owner via the SHARED form
 * executor driven by a fresh on-behalf token.
 *
 * The on-behalf token mint, the owner-role resolver, and the shared form
 * executor are STUBBED (no network, no db, no real signing); the dispatcher,
 * registry, OGIAM gate, autofill, and executor are real. We assert the agent
 * calls executeFormAction with formKind "create_task", auto-filled values
 * carrying title "Demo" + the owner-default listId, and a Bearer on-behalf
 * token, and that the step is "ran".
 */
const mockListCached = jest.fn();
jest.mock("@/lib/integrations/microsoft-tasks", () => ({
  listCachedTaskLists: (...a: unknown[]) => mockListCached(...a),
}));
jest.mock("@/lib/ogiam/ledger", () => ({
  ...jest.requireActual("@/lib/ogiam/ledger"),
  recordDecision: jest.fn(() => Promise.resolve({ id: "d_test", seq: 1, entryHash: "h" })),
}));
jest.mock("@/lib/analytics", () => ({ trackEvent: jest.fn() }));
jest.mock("@/lib/db", () => ({ safeQuery: jest.fn(() => Promise.resolve({ rows: [] })), writeQuery: jest.fn(() => Promise.resolve({ rows: [] })) }));

import "@/lib/assistant/tools";
import { runAgentTask } from "@/lib/agents/tasks/executor";

beforeEach(() => {
  mockListCached.mockReset();
});

test("agent 'add a task titled Demo' routes to create_task_form and executes on behalf of the owner", async () => {
  // The owner has one writable To-Do list, so the form carries a real default
  // listId the autofill picks up.
  mockListCached.mockResolvedValue([{ id: "u-1", msListId: "OWNER-LIST", displayName: "Tasks" }]);

  const mintToken = jest.fn().mockResolvedValue("onbehalf-token-abc");
  const getOwnerRole = jest.fn().mockResolvedValue({ role: "dev", workspaceId: "ws-1" });
  const executeForm = jest.fn().mockResolvedValue(
    new Response(JSON.stringify({ ok: true, message: 'Created task "Demo".' }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );

  const out = await runAgentTask(
    { id: "task-x", goal: "add a task titled Demo", agentId: "agent-1", role: "dev", workspaceId: "ws-1", ownerUserId: "owner-9" },
    {
      lookupProcedure: (async () => null) as never,
      recordProcedure: (async () => null) as never,
      ground: (async () => ({ used: false, hits: 0, snippets: [] })) as never,
      getOwnerRole: getOwnerRole as never,
      mintToken: mintToken as never,
      executeForm: executeForm as never,
      origin: (() => "https://internal.example") as never,
    },
  );

  // It MATCHED create_task_form (not no_match) and actually ran.
  expect(out.steps[0].tool).toBe("create_task_form");
  expect(out.steps[0].outcome).toBe("ran");
  expect(out.status).toBe("succeeded");

  // The form was built against the OWNER's lists (onBehalfOfUserId = owner).
  expect(mockListCached).toHaveBeenCalledWith("owner-9");

  // A fresh on-behalf token was minted carrying the OWNER's role (never elevated).
  expect(getOwnerRole).toHaveBeenCalledWith("owner-9");
  expect(mintToken).toHaveBeenCalledWith(
    expect.objectContaining({ ownerUserId: "owner-9", ownerRole: "dev", workspaceId: "ws-1", agentId: "agent-1" }),
  );

  // The shared executor ran with formKind create_task, auto-filled values, and
  // the Bearer on-behalf token.
  expect(executeForm).toHaveBeenCalledTimes(1);
  const [kind, values, ctx] = executeForm.mock.calls[0];
  expect(kind).toBe("create_task");
  expect(values).toEqual(expect.objectContaining({ title: "Demo", listId: "OWNER-LIST" }));
  expect(ctx.authHeader).toBe("Bearer onbehalf-token-abc");
  expect(ctx.origin).toBe("https://internal.example");
});
