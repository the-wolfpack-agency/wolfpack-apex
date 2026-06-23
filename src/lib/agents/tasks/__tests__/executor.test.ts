/**
 * Governed executor tests. The dispatcher and the notifier are injected, so we
 * prove the loop behavior without a database or the assistant: every step runs
 * under the agent identity, a gate block stops the run and escalates to the
 * owner, and unmatched or failing steps are recorded correctly.
 */

jest.mock("@/lib/analytics", () => ({ trackEvent: jest.fn() }));

import { trackEvent } from "@/lib/analytics";
import {
  runAgentTask,
  familiarityScore,
  type ExecutableTask,
} from "@/lib/agents/tasks/executor";

const mockTrackEvent = trackEvent as jest.MockedFunction<typeof trackEvent>;

/** The metadata object the executor passed to a given analytics event. */
function metaFor(event: string): Record<string, unknown> | undefined {
  const call = mockTrackEvent.mock.calls.find((c) => c[0] === event);
  return call?.[3] as Record<string, unknown> | undefined;
}

const task: ExecutableTask = {
  id: "task-1",
  goal: "1. read status\n2. delete everything",
  agentId: "agent-1",
  role: "ops",
  workspaceId: "ws-1",
  ownerUserId: "owner-1",
};

function ran(tool: string, answer: string) {
  return { tool, result: { ok: true as const, data: {}, answer, sources: [] }, durationMs: 1 };
}
function gateBlock(tool: string) {
  return {
    tool,
    result: { ok: false as const, code: "capability" as const, message: "OGIAM escalate: high-risk action (rule R-HIGHRISK-MUTATION-ESCALATE)" },
    durationMs: 1,
  };
}

describe("runAgentTask", () => {
  it("runs every step under the agent identity and succeeds", async () => {
    const dispatch = jest.fn()
      .mockResolvedValueOnce(ran("read_status", "status ok"))
      .mockResolvedValueOnce(ran("read_more", "more ok"));
    const notifyOwner = jest.fn();
    const out = await runAgentTask(task, { dispatch: dispatch as never, notifyOwner: notifyOwner as never });

    expect(out.status).toBe("succeeded");
    expect(out.steps.map((s) => s.outcome)).toEqual(["ran", "ran"]);
    expect(notifyOwner).not.toHaveBeenCalled();
    // Each dispatch ran as the agent principal (enforce attribution).
    const ctx = dispatch.mock.calls[0][1];
    expect(ctx.agentPrincipal.agentId).toBe("agent-1");
    expect(ctx.userId).toBe("agent-1");
  });

  it("stops and escalates to the owner when a step is gate-blocked", async () => {
    const dispatch = jest.fn()
      .mockResolvedValueOnce(ran("read_status", "ok"))
      .mockResolvedValueOnce(gateBlock("delete_everything"));
    const notifyOwner = jest.fn().mockResolvedValue({ id: "n1" });
    const out = await runAgentTask(task, { dispatch: dispatch as never, notifyOwner: notifyOwner as never });

    expect(out.status).toBe("blocked");
    expect(out.steps[1].outcome).toBe("blocked");
    // The owner is notified for approval, and the run stops at the block.
    expect(notifyOwner).toHaveBeenCalledTimes(1);
    const arg = notifyOwner.mock.calls[0][0];
    expect(arg.userId).toBe("owner-1");
    expect(arg.category).toBe("agent");
    expect(arg.sourceId).toBe("task-1");
    expect(dispatch).toHaveBeenCalledTimes(2); // did not run a third step
  });

  it("records a step with no matching tool and continues", async () => {
    const dispatch = jest.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(ran("read_more", "ok"));
    const out = await runAgentTask(task, { dispatch: dispatch as never, notifyOwner: jest.fn() as never });
    expect(out.steps[0].outcome).toBe("no_match");
    expect(out.steps[1].outcome).toBe("ran");
    expect(out.status).toBe("succeeded");
  });

  it("FAILS (not succeeds) when a step returns a tool error", async () => {
    /* Regression: a step that returned ok:false used to leave status at the
       default "succeeded", so the UI showed "Succeeded / Completed 0 of 1". */
    const toolError = {
      tool: "delegate_to_agent",
      result: { ok: false as const, code: "internal" as const, message: "could not resolve agent" },
      durationMs: 1,
    };
    const dispatch = jest.fn().mockResolvedValueOnce(toolError);
    const out = await runAgentTask(
      { ...task, goal: "do the thing" },
      {
        dispatch: dispatch as never, notifyOwner: jest.fn() as never,
        lookupProcedure: jest.fn().mockResolvedValue(null) as never,
        recordProcedure: jest.fn() as never,
      },
    );
    expect(out.status).toBe("failed");
    expect(out.steps[0].outcome).toBe("error");
    expect(out.resultSummary).toMatch(/Failed/);
  });

  it("FAILS when nothing ran (all steps unmatched)", async () => {
    const dispatch = jest.fn().mockResolvedValue(null);
    const out = await runAgentTask(
      { ...task, goal: "mystery instruction" },
      {
        dispatch: dispatch as never, notifyOwner: jest.fn() as never,
        lookupProcedure: jest.fn().mockResolvedValue(null) as never,
        recordProcedure: jest.fn() as never,
      },
    );
    expect(out.status).toBe("failed");
  });

  it("EXECUTES a form step on behalf of the owner (ran), via on-behalf token + shared executor", async () => {
    /* The generic agent path: a form-returning tool (create_task_form) is
       auto-filled from the instruction and executed AS THE OWNER through a
       freshly minted, short-lived on-behalf token + the shared form executor.
       A 2xx response counts as a real "ran" step (replaces the old
       "form -> error" behavior). */
    const formResult = {
      tool: "create_task_form",
      result: {
        ok: true as const,
        data: { formKind: "create_task" },
        answer: "Fill in the task below.",
        form: {
          formKind: "create_task",
          fields: [
            { name: "title", label: "Title", type: "text", required: true },
            { name: "listId", label: "List", type: "select", required: true, defaultValue: "LIST-A" },
          ],
        },
        sources: [],
      },
      durationMs: 1,
    };
    const dispatch = jest.fn().mockResolvedValueOnce(formResult);
    const getOwnerRole = jest.fn().mockResolvedValue({ role: "dev", workspaceId: "ws-1" });
    const mintToken = jest.fn().mockResolvedValue("onbehalf-token-xyz");
    const executeForm = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, message: 'Created task "Doctors Appointment".' }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const out = await runAgentTask(
      { ...task, goal: "add a task titled Doctors Appointment" },
      {
        dispatch: dispatch as never, notifyOwner: jest.fn() as never,
        lookupProcedure: jest.fn().mockResolvedValue(null) as never,
        recordProcedure: jest.fn() as never,
        getOwnerRole: getOwnerRole as never,
        mintToken: mintToken as never,
        executeForm: executeForm as never,
        origin: (() => "https://internal.example") as never,
      },
    );

    expect(out.status).toBe("succeeded");
    expect(out.steps[0].outcome).toBe("ran");
    // The owner's role drove the token (never elevated).
    expect(getOwnerRole).toHaveBeenCalledWith("owner-1");
    expect(mintToken).toHaveBeenCalledWith(
      expect.objectContaining({ ownerUserId: "owner-1", ownerRole: "dev", workspaceId: "ws-1", agentId: "agent-1" }),
    );
    // The shared executor ran with the on-behalf bearer + auto-filled values.
    expect(executeForm).toHaveBeenCalledTimes(1);
    const [kind, values, ctx] = executeForm.mock.calls[0];
    expect(kind).toBe("create_task");
    expect(values).toEqual(expect.objectContaining({ title: "Doctors Appointment", listId: "LIST-A" }));
    expect(ctx.authHeader).toBe("Bearer onbehalf-token-xyz");
    expect(ctx.origin).toBe("https://internal.example");
  });

  it("BLOCKS + notifies the owner when the form has a required field it cannot fill", async () => {
    const formResult = {
      tool: "create_task_form",
      result: {
        ok: true as const,
        data: { formKind: "create_task" },
        answer: "Fill in the task below.",
        form: {
          formKind: "create_task",
          fields: [
            { name: "title", label: "Title", type: "text", required: true },
            // No default and not extractable from the instruction -> missing.
            { name: "listId", label: "List", type: "text", required: true },
          ],
        },
        sources: [],
      },
      durationMs: 1,
    };
    const dispatch = jest.fn().mockResolvedValueOnce(formResult);
    const notifyOwner = jest.fn().mockResolvedValue({ id: "n1" });
    const executeForm = jest.fn();
    const out = await runAgentTask(
      { ...task, goal: "add a task" },
      {
        dispatch: dispatch as never, notifyOwner: notifyOwner as never,
        lookupProcedure: jest.fn().mockResolvedValue(null) as never,
        recordProcedure: jest.fn() as never,
        getOwnerRole: jest.fn().mockResolvedValue({ role: "dev", workspaceId: "ws-1" }) as never,
        mintToken: jest.fn() as never,
        executeForm: executeForm as never,
      },
    );

    expect(out.status).toBe("blocked");
    expect(out.steps[0].outcome).toBe("blocked");
    // Never executed the action when input is missing.
    expect(executeForm).not.toHaveBeenCalled();
    // Owner was notified about the missing input.
    expect(notifyOwner).toHaveBeenCalledTimes(1);
    const arg = notifyOwner.mock.calls[0][0];
    expect(arg.userId).toBe("owner-1");
    expect(arg.body).toMatch(/listId/);
  });

  it("ERRORS a form step (not succeeds) when the on-behalf execution returns non-2xx", async () => {
    const formResult = {
      tool: "create_task_form",
      result: {
        ok: true as const,
        data: { formKind: "create_task" },
        answer: "Fill in the task below.",
        form: {
          formKind: "create_task",
          fields: [{ name: "title", label: "Title", type: "text", required: true }],
        },
        sources: [],
      },
      durationMs: 1,
    };
    const dispatch = jest.fn().mockResolvedValueOnce(formResult);
    const executeForm = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: false, code: "auth", message: "Microsoft account not connected." }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const out = await runAgentTask(
      { ...task, goal: "add a task titled Demo" },
      {
        dispatch: dispatch as never, notifyOwner: jest.fn() as never,
        lookupProcedure: jest.fn().mockResolvedValue(null) as never,
        recordProcedure: jest.fn() as never,
        getOwnerRole: jest.fn().mockResolvedValue({ role: "dev", workspaceId: "ws-1" }) as never,
        mintToken: jest.fn().mockResolvedValue("tok") as never,
        executeForm: executeForm as never,
      },
    );
    expect(out.status).toBe("failed");
    expect(out.steps[0].outcome).toBe("error");
    expect(out.steps[0].detail).toMatch(/Microsoft account not connected/);
  });

  it("fails safe when a dispatch throws", async () => {
    const dispatch = jest.fn().mockRejectedValue(new Error("boom"));
    const out = await runAgentTask(task, {
      dispatch: dispatch as never, notifyOwner: jest.fn() as never,
      lookupProcedure: jest.fn().mockResolvedValue(null) as never,
      recordProcedure: jest.fn() as never,
    });
    expect(out.status).toBe("failed");
    expect(out.steps[0].outcome).toBe("error");
  });
});

describe("cumulative memory inheritance", () => {
  it("reuses a promoted procedure and does NOT relearn it", async () => {
    const dispatch = jest.fn().mockResolvedValue(ran("read_status", "ok"));
    const lookupProcedure = jest.fn().mockResolvedValue({
      plan: [{ instruction: "inherited step", tool: "read_status" }],
    });
    const recordProcedure = jest.fn();
    const out = await runAgentTask(
      { ...task, goal: "do the known thing" },
      { dispatch: dispatch as never, notifyOwner: jest.fn() as never, lookupProcedure: lookupProcedure as never, recordProcedure: recordProcedure as never },
    );
    expect(out.inherited).toBe(true);
    // The inherited plan was run (one step), not the planner's split of the goal.
    expect(dispatch).toHaveBeenCalledWith("inherited step", expect.anything());
    // An inherited plan is not re-recorded.
    expect(recordProcedure).not.toHaveBeenCalled();
  });

  it("records a freshly explored successful plan for future agents to inherit", async () => {
    const dispatch = jest.fn()
      .mockResolvedValueOnce(ran("read_status", "ok"))
      .mockResolvedValueOnce(ran("read_more", "ok"));
    const lookupProcedure = jest.fn().mockResolvedValue(null);
    const recordProcedure = jest.fn().mockResolvedValue({ status: "promoted" });
    const out = await runAgentTask(
      { ...task, goal: "read status\nread more" },
      { dispatch: dispatch as never, notifyOwner: jest.fn() as never, lookupProcedure: lookupProcedure as never, recordProcedure: recordProcedure as never },
    );
    expect(out.inherited).toBe(false);
    expect(out.status).toBe("succeeded");
    expect(recordProcedure).toHaveBeenCalledTimes(1);
    const arg = recordProcedure.mock.calls[0][0];
    expect(arg.goal).toBe("read status\nread more");
    expect(arg.plan).toHaveLength(2);
  });

  it("does NOT record a blocked task (only fully successful plans are learned)", async () => {
    const dispatch = jest.fn()
      .mockResolvedValueOnce(ran("read_status", "ok"))
      .mockResolvedValueOnce(gateBlock("delete_everything"));
    const recordProcedure = jest.fn();
    const out = await runAgentTask(task, {
      dispatch: dispatch as never, notifyOwner: jest.fn().mockResolvedValue({}) as never,
      lookupProcedure: jest.fn().mockResolvedValue(null) as never, recordProcedure: recordProcedure as never,
    });
    expect(out.status).toBe("blocked");
    expect(recordProcedure).not.toHaveBeenCalled();
  });
});

describe("maturation: deterministic-first grounding + cost-aware model selection", () => {
  beforeEach(() => mockTrackEvent.mockClear());

  const modelSel = {
    model: { id: "gpt-4o-mini", provider: "openai", capabilityTier: "large" },
    reason: "cheapest_at_tier",
    estimatedCostUsd: 0.0021,
  };

  it("an INHERITED run does NOT ground or select a model (deterministic-first, zero token consideration)", async () => {
    const dispatch = jest.fn().mockResolvedValue(ran("read_status", "ok"));
    const lookupProcedure = jest.fn().mockResolvedValue({
      plan: [{ instruction: "inherited step", tool: "read_status" }],
    });
    const ground = jest.fn();
    const selectModel = jest.fn();
    const logModelSelection = jest.fn();

    const out = await runAgentTask(
      { ...task, goal: "do the known thing" },
      {
        dispatch: dispatch as never,
        notifyOwner: jest.fn() as never,
        lookupProcedure: lookupProcedure as never,
        recordProcedure: jest.fn() as never,
        ground: ground as never,
        selectModel: selectModel as never,
        logModelSelection: logModelSelection as never,
      },
    );

    expect(out.inherited).toBe(true);
    // Reuse is free: no Brain spend, no model decision.
    expect(ground).not.toHaveBeenCalled();
    expect(selectModel).not.toHaveBeenCalled();
    expect(logModelSelection).not.toHaveBeenCalled();
    // The dispatch ctx carries no grounding for a deterministic run.
    const ctx = dispatch.mock.calls[0][1];
    expect(ctx.grounding).toBeUndefined();

    const meta = metaFor("agent.task_completed");
    expect(meta?.inherited).toBe(true);
    expect(meta?.brain_grounded).toBe(false);
    expect(meta?.model_id).toBeUndefined();

    const g = metaFor("agent.execution_grounded");
    expect(g?.inherited).toBe(true);
    expect(g?.brain_grounded).toBe(false);
  });

  it("a NON-inherited successful run grounds, selects a model, and attaches grounding to the dispatch ctx", async () => {
    const dispatch = jest.fn().mockResolvedValue(ran("read_status", "ok"));
    const ground = jest
      .fn()
      .mockResolvedValue({ used: true, hits: 2, snippets: ["org fact A", "org fact B"] });
    const selectModel = jest.fn().mockReturnValue(modelSel);
    const logModelSelection = jest.fn();

    const out = await runAgentTask(
      { ...task, goal: "explore something new" },
      {
        dispatch: dispatch as never,
        notifyOwner: jest.fn() as never,
        lookupProcedure: jest.fn().mockResolvedValue(null) as never,
        recordProcedure: jest.fn().mockResolvedValue({ status: "promoted" }) as never,
        ground: ground as never,
        selectModel: selectModel as never,
        logModelSelection: logModelSelection as never,
      },
    );

    expect(out.inherited).toBe(false);
    expect(out.status).toBe("succeeded");
    // The agent consulted the Brain and the cost-aware router.
    expect(ground).toHaveBeenCalledWith(
      "explore something new",
      "ws-1",
      expect.objectContaining({ userId: "agent-1", userRole: "ops" }),
    );
    expect(selectModel).toHaveBeenCalledWith(
      expect.objectContaining({ requiredTier: "large" }),
    );
    expect(logModelSelection).toHaveBeenCalledTimes(1);

    // The dispatch ctx carries the org-knowledge snippets so AI-backed tools
    // are grounded.
    const ctx = dispatch.mock.calls[0][1];
    expect(ctx.grounding).toEqual({ snippets: ["org fact A", "org fact B"] });

    const meta = metaFor("agent.task_completed");
    expect(meta?.inherited).toBe(false);
    expect(meta?.brain_grounded).toBe(true);
    expect(meta?.model_id).toBe("gpt-4o-mini");

    const g = metaFor("agent.execution_grounded");
    expect(g?.inherited).toBe(false);
    expect(g?.brain_hits).toBe(2);
    expect(g?.brain_grounded).toBe(true);
    expect(g?.model_id).toBe("gpt-4o-mini");
    expect(g?.est_cost_usd).toBe(0.0021);
  });

  it("completes the task gracefully when grounding AND model selection throw", async () => {
    const dispatch = jest.fn().mockResolvedValue(ran("read_status", "ok"));
    const ground = jest.fn().mockRejectedValue(new Error("brain down"));
    const selectModel = jest.fn(() => {
      throw new Error("router down");
    });
    const logModelSelection = jest.fn();

    const out = await runAgentTask(
      { ...task, goal: "explore with broken deps" },
      {
        dispatch: dispatch as never,
        notifyOwner: jest.fn() as never,
        lookupProcedure: jest.fn().mockResolvedValue(null) as never,
        recordProcedure: jest.fn().mockResolvedValue({ status: "promoted" }) as never,
        ground: ground as never,
        selectModel: selectModel as never,
        logModelSelection: logModelSelection as never,
      },
    );

    // Graceful degradation: the task still runs and succeeds.
    expect(out.status).toBe("succeeded");
    const ctx = dispatch.mock.calls[0][1];
    expect(ctx.grounding).toBeUndefined();
    const meta = metaFor("agent.task_completed");
    expect(meta?.brain_grounded).toBe(false);
    expect(meta?.model_id).toBeUndefined();
  });

  it("runs ungrounded (no ctx grounding) when the Brain returns zero snippets", async () => {
    const dispatch = jest.fn().mockResolvedValue(ran("read_status", "ok"));
    const ground = jest.fn().mockResolvedValue({ used: true, hits: 0, snippets: [] });
    const selectModel = jest.fn().mockReturnValue(modelSel);

    const out = await runAgentTask(
      { ...task, goal: "explore but no brain hits" },
      {
        dispatch: dispatch as never,
        notifyOwner: jest.fn() as never,
        lookupProcedure: jest.fn().mockResolvedValue(null) as never,
        recordProcedure: jest.fn().mockResolvedValue({ status: "promoted" }) as never,
        ground: ground as never,
        selectModel: selectModel as never,
        logModelSelection: jest.fn() as never,
      },
    );

    expect(out.status).toBe("succeeded");
    const ctx = dispatch.mock.calls[0][1];
    expect(ctx.grounding).toBeUndefined();
    expect(metaFor("agent.task_completed")?.brain_grounded).toBe(false);
    // A model is still selected even with no Brain hits.
    expect(metaFor("agent.task_completed")?.model_id).toBe("gpt-4o-mini");
  });
});

describe("familiarityScore", () => {
  it("is 0 for an all-explored history", () => {
    expect(
      familiarityScore([{ inherited: false }, { inherited: false }]),
    ).toBe(0);
  });

  it("is 1 for an all-inherited history", () => {
    expect(
      familiarityScore([{ inherited: true }, { inherited: true }]),
    ).toBe(1);
  });

  it("is the correct fraction for a mix", () => {
    expect(
      familiarityScore([
        { inherited: true },
        { inherited: false },
        { inherited: true },
        { inherited: false },
      ]),
    ).toBe(0.5);
  });

  it("is 0 for an empty history", () => {
    expect(familiarityScore([])).toBe(0);
  });
});
