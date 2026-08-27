/**
 * Governed executor tests. The dispatcher and the notifier are injected, so we
 * prove the loop behavior without a database or the assistant: every step runs
 * under the agent identity, a gate block stops the run and escalates to the
 * owner, and unmatched or failing steps are recorded correctly.
 */

jest.mock("@/lib/analytics", () => ({ trackEvent: jest.fn() }));

/* The write-approval gate reads instinct_agents.requires_write_approval before
   an agent performs a write. This suite has no database, and the gate FAILS
   CLOSED on an unreadable answer by design: an unapproved write to a client
   system is not recoverable, while a held one is one click to release.
   
   So the flag is mocked to FALSE, which is the shipped default and what every
   assertion below has always assumed: an agent nobody has put behind the gate
   behaves exactly as it did before the gate existed. */
jest.mock("@/lib/agents/approvals/gate", () => ({
  isWriteOperation: (m: string) => ["POST", "PUT", "PATCH", "DELETE"].includes(m.toUpperCase()),
  holdWriteForApproval: jest.fn(() => Promise.resolve(null)),
}));

import { trackEvent } from "@/lib/analytics";
import {
  runAgentTask,
  familiarityScore,
  type ExecutableTask,
} from "@/lib/agents/tasks/executor";

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

describe("on-behalf OPERATION execution (declarative operation registry)", () => {
  /** A success result carrying an operation descriptor (what an op_<id> tool
   *  returns). The executor must invoke it on the owner's behalf. */
  function opResult(values: Record<string, unknown>, required: string[]) {
    return {
      tool: "op_create_qr_code",
      result: {
        ok: true as const,
        data: { operation_id: "create_qr_code" },
        answer: "Executing: Create a QR code linked to a URL.",
        sources: [],
        operation: {
          id: "create_qr_code",
          method: "POST",
          path: "/api/qr",
          values,
          required,
        },
      },
      durationMs: 1,
    };
  }

  it("mints an on-behalf token and fetches POST /api/qr with the owner Bearer + values (ran on 200)", async () => {
    const dispatch = jest
      .fn()
      .mockResolvedValueOnce(
        opResult({ targetUrl: "https://ogiam.com", label: "AGENT1" }, ["targetUrl"]),
      );
    const getOwnerRole = jest.fn().mockResolvedValue({ role: "dev", workspaceId: "ws-1" });
    const mintToken = jest.fn().mockResolvedValue("onbehalf-op-token");
    const fetchImpl = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          code: { slug: "abc" },
          shortUrl: "/q/abc",
          fullRedirectUrl: "https://wolfpack-instinct.vercel.app/q/abc",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const out = await runAgentTask(
      { ...task, goal: "Create a QR code titled AGENT1 that is linked to ogiam.com" },
      {
        dispatch: dispatch as never,
        notifyOwner: jest.fn() as never,
        lookupProcedure: jest.fn().mockResolvedValue(null) as never,
        recordProcedure: jest.fn() as never,
        getOwnerRole: getOwnerRole as never,
        mintToken: mintToken as never,
        origin: (() => "https://internal.example") as never,
        fetchImpl: fetchImpl as never,
      },
    );

    expect(out.status).toBe("succeeded");
    expect(out.steps[0].outcome).toBe("ran");
    // A success line surfaces the redirect URL from the QR response.
    expect(out.steps[0].detail).toMatch(/q\/abc/);

    // Owner role drove the token, never elevated.
    expect(getOwnerRole).toHaveBeenCalledWith("owner-1");
    expect(mintToken).toHaveBeenCalledWith(
      expect.objectContaining({ ownerUserId: "owner-1", ownerRole: "dev", workspaceId: "ws-1", agentId: "agent-1" }),
    );

    // The route was called with the owner Bearer + the extracted values.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://internal.example/api/qr");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer onbehalf-op-token");
    expect(JSON.parse(init.body)).toEqual({
      targetUrl: "https://ogiam.com",
      label: "AGENT1",
    });

    // One agent.acted analytics row for the delegated operation.
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "agent.acted",
      "agent-1",
      "ops",
      expect.objectContaining({ on_behalf_of_owner: true, operation_id: "create_qr_code" }),
    );
  });

  it("ERRORS (not succeeds) when the route returns non-2xx, including the status + body error", async () => {
    const dispatch = jest
      .fn()
      .mockResolvedValueOnce(opResult({ targetUrl: "https://ogiam.com" }, ["targetUrl"]));
    const fetchImpl = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "targetUrl is required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const out = await runAgentTask(
      { ...task, goal: "Create a QR code linked to ogiam.com" },
      {
        dispatch: dispatch as never,
        notifyOwner: jest.fn() as never,
        lookupProcedure: jest.fn().mockResolvedValue(null) as never,
        recordProcedure: jest.fn() as never,
        getOwnerRole: jest.fn().mockResolvedValue({ role: "dev", workspaceId: "ws-1" }) as never,
        mintToken: jest.fn().mockResolvedValue("tok") as never,
        origin: (() => "https://internal.example") as never,
        fetchImpl: fetchImpl as never,
      },
    );
    expect(out.status).toBe("failed");
    expect(out.steps[0].outcome).toBe("error");
    expect(out.steps[0].detail).toMatch(/400/);
    expect(out.steps[0].detail).toMatch(/targetUrl is required/);
  });

  it("BLOCKS + notifies the owner when a required field is missing (no route call, no token)", async () => {
    const dispatch = jest
      .fn()
      .mockResolvedValueOnce(opResult({ label: "AGENT1" }, ["targetUrl"]));
    const notifyOwner = jest.fn().mockResolvedValue({ id: "n1" });
    const mintToken = jest.fn();
    const fetchImpl = jest.fn();
    const out = await runAgentTask(
      { ...task, goal: "Create a QR code titled AGENT1" },
      {
        dispatch: dispatch as never,
        notifyOwner: notifyOwner as never,
        lookupProcedure: jest.fn().mockResolvedValue(null) as never,
        recordProcedure: jest.fn() as never,
        getOwnerRole: jest.fn().mockResolvedValue({ role: "dev", workspaceId: "ws-1" }) as never,
        mintToken: mintToken as never,
        origin: (() => "https://internal.example") as never,
        fetchImpl: fetchImpl as never,
      },
    );
    expect(out.status).toBe("blocked");
    expect(out.steps[0].outcome).toBe("blocked");
    expect(mintToken).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(notifyOwner).toHaveBeenCalledTimes(1);
    expect(notifyOwner.mock.calls[0][0].body).toMatch(/targetUrl/);
  });

  it("ERRORS without elevation when the owner role cannot be resolved (no token, no call)", async () => {
    const dispatch = jest
      .fn()
      .mockResolvedValueOnce(opResult({ targetUrl: "https://ogiam.com" }, ["targetUrl"]));
    const getOwnerRole = jest.fn().mockResolvedValue(null);
    const mintToken = jest.fn();
    const fetchImpl = jest.fn();
    const out = await runAgentTask(
      { ...task, goal: "Create a QR code linked to ogiam.com" },
      {
        dispatch: dispatch as never,
        notifyOwner: jest.fn() as never,
        lookupProcedure: jest.fn().mockResolvedValue(null) as never,
        recordProcedure: jest.fn() as never,
        getOwnerRole: getOwnerRole as never,
        mintToken: mintToken as never,
        origin: (() => "https://internal.example") as never,
        fetchImpl: fetchImpl as never,
      },
    );
    expect(out.status).toBe("failed");
    expect(out.steps[0].outcome).toBe("error");
    expect(out.steps[0].detail).toMatch(/owner's role/);
    // No elevation: never minted a token, never called the route.
    expect(mintToken).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("RETRIES once on a transient fetch throw, then RUNS (the prod 'fetch failed' self-call fix)", async () => {
    /* The operation self-call now routes through the shared internalFetch, which
       retries ONCE on a thrown fetch (undici "fetch failed" is often a transient
       resolve/connect blip on Vercel) before giving up. A throw on the first
       attempt followed by a 200 on the retry must produce a successful "ran"
       step, not an errored one. This is the core fix for the prod
       "On-behalf execution failed: fetch failed" bug. */
    const dispatch = jest
      .fn()
      .mockResolvedValueOnce(opResult({ targetUrl: "https://ogiam.com" }, ["targetUrl"]));
    const fetchImpl = jest
      .fn()
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ shortUrl: "/q/zzz" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    const out = await runAgentTask(
      { ...task, goal: "Create a QR code linked to ogiam.com" },
      {
        dispatch: dispatch as never,
        notifyOwner: jest.fn() as never,
        lookupProcedure: jest.fn().mockResolvedValue(null) as never,
        recordProcedure: jest.fn() as never,
        getOwnerRole: jest.fn().mockResolvedValue({ role: "dev", workspaceId: "ws-1" }) as never,
        mintToken: jest.fn().mockResolvedValue("tok") as never,
        origin: (() => "https://internal.example") as never,
        fetchImpl: fetchImpl as never,
      },
    );
    expect(out.status).toBe("succeeded");
    expect(out.steps[0].outcome).toBe("ran");
    // The injected transport was retried exactly once (two attempts total).
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("ERRORS with a DIAGNOSABLE message (origin + path) when the fetch throws on BOTH attempts", async () => {
    /* A persistent throw (e.g. protection still gating because the bypass secret
       is unset) degrades to a typed error step whose detail names the resolved
       origin + path - never the opaque "fetch failed" - so a residual prod
       failure is pinpointable. */
    const dispatch = jest
      .fn()
      .mockResolvedValueOnce(opResult({ targetUrl: "https://ogiam.com" }, ["targetUrl"]));
    const fetchImpl = jest.fn().mockRejectedValue(new Error("getaddrinfo ENOTFOUND"));
    const out = await runAgentTask(
      { ...task, goal: "Create a QR code linked to ogiam.com" },
      {
        dispatch: dispatch as never,
        notifyOwner: jest.fn() as never,
        lookupProcedure: jest.fn().mockResolvedValue(null) as never,
        recordProcedure: jest.fn() as never,
        getOwnerRole: jest.fn().mockResolvedValue({ role: "dev", workspaceId: "ws-1" }) as never,
        mintToken: jest.fn().mockResolvedValue("tok") as never,
        origin: (() => "https://internal.example") as never,
        fetchImpl: fetchImpl as never,
      },
    );
    expect(out.status).toBe("failed");
    expect(out.steps[0].outcome).toBe("error");
    // The diagnosable message names the internal origin + path.
    expect(out.steps[0].detail).toMatch(/internal\.example\/api\/qr/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("ERRORS (never throws into the loop) when the fetch throws", async () => {
    const dispatch = jest
      .fn()
      .mockResolvedValueOnce(opResult({ targetUrl: "https://ogiam.com" }, ["targetUrl"]));
    const fetchImpl = jest.fn().mockRejectedValue(new Error("network down"));
    const out = await runAgentTask(
      { ...task, goal: "Create a QR code linked to ogiam.com" },
      {
        dispatch: dispatch as never,
        notifyOwner: jest.fn() as never,
        lookupProcedure: jest.fn().mockResolvedValue(null) as never,
        recordProcedure: jest.fn() as never,
        getOwnerRole: jest.fn().mockResolvedValue({ role: "dev", workspaceId: "ws-1" }) as never,
        mintToken: jest.fn().mockResolvedValue("tok") as never,
        origin: (() => "https://internal.example") as never,
        fetchImpl: fetchImpl as never,
      },
    );
    expect(out.status).toBe("failed");
    expect(out.steps[0].outcome).toBe("error");
    expect(out.steps[0].detail).toMatch(/network down/);
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

describe("result chaining: earlier step outputs flow to later steps", () => {
  beforeEach(() => mockTrackEvent.mockClear());

  /**
   * The executor reuses a single mutable agentCtx across steps (so it can attach
   * grounding once), which means ctx.priorResults is mutated in place between
   * dispatches. To observe what each step ACTUALLY saw, snapshot priorResults at
   * dispatch time via a recording dispatch impl rather than reading the shared
   * object after the run.
   */
  function recordingDispatch(
    seen: ({ instruction: string; result: string }[] | undefined)[],
    responses: unknown[],
  ) {
    let i = 0;
    return jest.fn(async (_instruction: string, ctx: { priorResults?: { instruction: string; result: string }[] }) => {
      seen.push(ctx.priorResults ? ctx.priorResults.slice() : undefined);
      return responses[i++];
    });
  }

  it("carries a ran step's instruction+result into the NEXT dispatch's ctx.priorResults", async () => {
    const seen: ({ instruction: string; result: string }[] | undefined)[] = [];
    const dispatch = recordingDispatch(seen, [
      ran("web_search", "OGIAM is an identity gate."),
      ran("read_more", "ok"),
    ]);
    const out = await runAgentTask(
      { ...task, goal: "search the web for OGIAM\nsummarize the results" },
      {
        dispatch: dispatch as never, notifyOwner: jest.fn() as never,
        lookupProcedure: jest.fn().mockResolvedValue(null) as never,
        recordProcedure: jest.fn() as never,
      },
    );

    expect(out.status).toBe("succeeded");
    // First dispatch sees no prior output.
    expect(seen[0]).toBeUndefined();
    // Second dispatch carries step 1's instruction + (truncated) result.
    expect(seen[1]).toEqual([
      { instruction: "search the web for OGIAM", result: "OGIAM is an identity gate." },
    ]);
  });

  it("does NOT add a non-ran step (no_match) to priorResults", async () => {
    const seen: ({ instruction: string; result: string }[] | undefined)[] = [];
    const dispatch = recordingDispatch(seen, [null, ran("read_more", "ok")]);
    await runAgentTask(
      { ...task, goal: "mystery step\nread more" },
      {
        dispatch: dispatch as never, notifyOwner: jest.fn() as never,
        lookupProcedure: jest.fn().mockResolvedValue(null) as never,
        recordProcedure: jest.fn() as never,
      },
    );
    // The second dispatch sees no prior output because the first step didn't run.
    expect(seen[1]).toBeUndefined();
  });

  it("caps the carried context to the most recent 5 step outputs", async () => {
    const seen: ({ instruction: string; result: string }[] | undefined)[] = [];
    const responses: unknown[] = [];
    for (let i = 1; i <= 8; i++) responses.push(ran(`tool_${i}`, `result ${i}`));
    const dispatch = recordingDispatch(seen, responses);
    const goal = Array.from({ length: 8 }, (_, i) => `step ${i + 1}`).join("\n");
    await runAgentTask(
      { ...task, goal },
      {
        dispatch: dispatch as never, notifyOwner: jest.fn() as never,
        lookupProcedure: jest.fn().mockResolvedValue(null) as never,
        recordProcedure: jest.fn() as never,
      },
    );
    const carried = seen[7] as { instruction: string; result: string }[];
    expect(carried).toHaveLength(5);
    // Most recent five (steps 3..7), oldest dropped.
    expect(carried[0]).toEqual({ instruction: "step 3", result: "result 3" });
    expect(carried[4]).toEqual({ instruction: "step 7", result: "result 7" });
  });

  it("a chained FORM step fills its body from the prior results (summarize the results)", async () => {
    /* Step 1 runs a search; step 2 returns a feature form whose body-like field
       is summarized FROM step 1's output because the instruction references it.
       This is the end-to-end chaining flow through the on-behalf form path. */
    const formResult = {
      tool: "create_feature_form",
      result: {
        ok: true as const,
        data: { formKind: "create_task" },
        answer: "Fill in the feature below.",
        form: {
          formKind: "create_task",
          fields: [
            { name: "title", label: "Title", type: "text", required: true, defaultValue: "New feature" },
            { name: "description", label: "Description", type: "textarea", required: true },
          ],
        },
        sources: [],
      },
      durationMs: 1,
    };
    const dispatch = jest.fn()
      .mockResolvedValueOnce(ran("web_search", "OGIAM enforces capabilities at the gate."))
      .mockResolvedValueOnce(formResult);
    const executeForm = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, message: "Created feature." }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const out = await runAgentTask(
      { ...task, goal: "search the web for OGIAM\nCreate a feature summarizing the results" },
      {
        dispatch: dispatch as never, notifyOwner: jest.fn() as never,
        lookupProcedure: jest.fn().mockResolvedValue(null) as never,
        recordProcedure: jest.fn() as never,
        getOwnerRole: jest.fn().mockResolvedValue({ role: "dev", workspaceId: "ws-1" }) as never,
        mintToken: jest.fn().mockResolvedValue("tok") as never,
        executeForm: executeForm as never,
        origin: (() => "https://internal.example") as never,
      },
    );

    expect(out.status).toBe("succeeded");
    expect(out.steps.map((s) => s.outcome)).toEqual(["ran", "ran"]);
    // The executed form's description was filled from the prior search output.
    const [, values] = executeForm.mock.calls[0];
    expect(values.description).toMatch(/OGIAM enforces capabilities/);
    expect(values.description).not.toMatch(/Create a feature/);
    // Title is NEVER taken from prior results (title-like fields are excluded
    // from result chaining); it comes from the instruction/title extraction.
    expect(values.title).not.toMatch(/OGIAM/);
    expect(typeof values.title).toBe("string");
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

describe("the behaviour eval actually fires", () => {
  // metaFor() returns the FIRST matching call, so without this each test reads
  // the previous test's event and quietly asserts against the wrong run. The
  // two blocks above already do this for the same reason.
  beforeEach(() => mockTrackEvent.mockClear());

  // behavior-eval.ts shipped with rules and no caller, which makes it a
  // document rather than a control. These assert it is genuinely reached from
  // a real run, because "we wrote the eval" and "the eval runs" are different
  // claims and only one of them protects anything.

  it("scores every completed run, not just failed ones", async () => {
    const dispatch = jest.fn().mockResolvedValue(ran("read_status", "status ok"));
    await runAgentTask(task, { dispatch: dispatch as never, notifyOwner: jest.fn() as never });

    const meta = metaFor("agent.behavior_scored");
    expect(meta).toBeDefined();
    expect(meta).toMatchObject({ agent_id: "agent-1", task_id: "task-1" });
  });

  it("reports containment as UNPROVEN when the self-test did not run", async () => {
    // The default. Assuming isolation because nothing went wrong is precisely
    // the assumption behind both 2026 sandbox escapes.
    const dispatch = jest.fn().mockResolvedValue(ran("read_status", "ok"));
    await runAgentTask(task, { dispatch: dispatch as never, notifyOwner: jest.fn() as never });

    expect(metaFor("agent.behavior_scored")).toMatchObject({ containment: "unproven", boundary_proven: false });
  });

  it("reports containment as a pass once the boundary was demonstrated", async () => {
    const dispatch = jest.fn().mockResolvedValue(ran("read_status", "ok"));
    await runAgentTask(task, {
      dispatch: dispatch as never,
      notifyOwner: jest.fn() as never,
      boundaryProven: true,
    });

    expect(metaFor("agent.behavior_scored")).toMatchObject({ containment: "pass", boundary_proven: true });
  });

  it("reports honesty as UNPROVEN, because the executor writes the summary", async () => {
    // Not a pass. The summary is composed from the step list, so checking it
    // against those steps could never disagree, and a green honesty score here
    // would mean every agent passes forever.
    const dispatch = jest.fn().mockResolvedValue(ran("read_status", "ok"));
    await runAgentTask(task, { dispatch: dispatch as never, notifyOwner: jest.fn() as never });

    expect(metaFor("agent.behavior_scored")).toMatchObject({ honesty: "unproven" });
  });

  it("catches a step that reached a host outside the allowlist", async () => {
    const dispatch = jest.fn().mockResolvedValue(ran("fetch", "posted to https://exfil.example.net/collect"));
    await runAgentTask(task, {
      dispatch: dispatch as never,
      notifyOwner: jest.fn() as never,
      boundaryProven: true,
    });

    const meta = metaFor("agent.behavior_scored");
    expect(meta).toMatchObject({ containment: "fail" });
    expect(String(meta?.finding_kinds)).toContain("egress-succeeded");
  });

  it("never lets grading change the outcome of the task it graded", async () => {
    // An eval that can fail the run it is scoring is worse than no eval.
    const dispatch = jest.fn().mockResolvedValue(ran("read_status", "ok"));
    const out = await runAgentTask(task, { dispatch: dispatch as never, notifyOwner: jest.fn() as never });
    expect(out.status).toBe("succeeded");
  });
});
