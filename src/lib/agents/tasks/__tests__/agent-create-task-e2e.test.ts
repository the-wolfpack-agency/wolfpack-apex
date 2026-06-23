/**
 * End-to-end through the REAL dispatcher + executor: an agent assigned
 * "add a task titled Demo" must route to create_task_form and actually create
 * the task on behalf of its owner. Only the MS integration, ledger, db, and
 * notifier are mocked; the dispatcher, registry, gate, and executor are real.
 */
const mockListCached = jest.fn();
const mockListLive = jest.fn();
const mockCreateTask = jest.fn();
jest.mock("@/lib/integrations/microsoft-tasks", () => ({
  listCachedTaskLists: (...a: unknown[]) => mockListCached(...a),
  listTaskLists: (...a: unknown[]) => mockListLive(...a),
  createTask: (...a: unknown[]) => mockCreateTask(...a),
}));
jest.mock("@/lib/ogiam/ledger", () => ({
  ...jest.requireActual("@/lib/ogiam/ledger"),
  recordDecision: jest.fn(() => Promise.resolve(null)),
}));
jest.mock("@/lib/analytics", () => ({ trackEvent: jest.fn() }));
jest.mock("@/lib/db", () => ({ safeQuery: jest.fn(() => Promise.resolve({ rows: [] })), writeQuery: jest.fn(() => Promise.resolve({ rows: [] })) }));

import "@/lib/assistant/tools";
import { runAgentTask } from "@/lib/agents/tasks/executor";

beforeEach(() => {
  mockListCached.mockReset();
  mockListLive.mockReset();
  mockCreateTask.mockReset();
});

test("agent 'add a task titled Demo' routes to create_task_form and creates it", async () => {
  mockListCached.mockResolvedValue([]);                       // cache empty
  mockListLive.mockResolvedValue([{ id: "G1", displayName: "Tasks" }]); // live has a list
  mockCreateTask.mockResolvedValue({ id: "t1", msTaskId: "m1" });

  const out = await runAgentTask(
    { id: "task-x", goal: "add a task titled Demo", agentId: "agent-1", role: "dev", workspaceId: "ws-1", ownerUserId: "owner-9" },
    { lookupProcedure: (async () => null) as never, recordProcedure: (async () => null) as never, ground: (async () => ({ used: false, hits: 0, snippets: [] })) as never },
  );

  expect(out.steps[0].tool).toBe("create_task_form");   // it MATCHED (not no_match)
  expect(out.steps[0].outcome).toBe("ran");
  expect(out.status).toBe("succeeded");
  expect(mockCreateTask).toHaveBeenCalledWith("owner-9", "G1", { title: "Demo" });
});
