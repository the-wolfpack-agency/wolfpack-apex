/**
 * Agent task executor: run an assigned task as a governed multi-step plan.
 *
 * For each planned step the executor dispatches the instruction through the
 * assistant tool dispatcher AS THE AGENT, so the OGIAM gate runs in enforce mode
 * and attributes every step to the agent's identity. A step the gate refuses
 * (deny or escalate) stops the run and escalates to the agent's human owner for
 * approval, which is the human-in-the-loop control. The whole thing is bounded
 * (the planner caps steps) and never throws into the caller.
 *
 * The dispatcher and the notifier are injected so the loop is unit testable
 * without a database, an LLM, or the notifications layer.
 */

// Import from the tools BARREL (not the dispatcher directly): the barrel's
// side-effect imports register the full tool set. The dispatcher alone does NOT
// register tools, so importing tryDispatchTool from it left the agent execution
// path with a PARTIAL registry - any tool not transitively imported silently
// returned no_match (e.g. CRM search: "check salesforce for client list"), while
// the human chat path worked because it loads the barrel via assistant.ts.
import { tryDispatchTool } from "@/lib/assistant/tools";
import { notify } from "@/lib/notifications/in-app";
import { trackEvent } from "@/lib/analytics";
import { getConstitution, CONSTITUTION_VERSION } from "@/lib/constitution";
import { safeQuery } from "@/lib/db";
import { mintOnBehalfToken } from "@/lib/agents/on-behalf";
import {
  autofillForm,
  referencesPriorOutput,
  summarizePriorResults,
} from "@/lib/agents/forms/autofill";
import {
  executeFormAction,
  KNOWN_FORM_KINDS,
} from "@/lib/assistant/forms/execute";
import type { FormKind, FormSpec } from "@/lib/assistant/forms/types";
import { resolveInternalOrigin } from "@/lib/qr/origin";
import { internalFetch } from "@/lib/http/internal-fetch";
import {
  findPromotedProcedure,
  recordLearnedProcedure,
} from "@/lib/agents/memory/store";
import {
  groundFromBrain,
  type Grounding,
} from "@/lib/agents/grounding/brain-grounding";
import {
  selectModel,
  logModelSelection,
  type ModelSelection,
} from "@/lib/ai/models";
import { getPlanner } from "./planner";
import type { TaskStatus, TaskStep } from "./types";

export interface ExecutableTask {
  id: string;
  goal: string;
  agentId: string;
  role: string;
  workspaceId: string;
  ownerUserId: string;
  /**
   * Run-context guidance from the task template (success criteria, context,
   * target). Attached to the agent run context so tools can honor it. NOT part
   * of the goal, so it never creates spurious plan steps.
   */
  guidance?: string;
}

type DispatchFn = typeof tryDispatchTool;
type NotifyFn = typeof notify;
type LookupFn = typeof findPromotedProcedure;
type RecordFn = typeof recordLearnedProcedure;
type GroundFn = typeof groundFromBrain;
type SelectModelFn = typeof selectModel;
type LogModelSelectionFn = typeof logModelSelection;

/** The owner's authority for a delegated (on-behalf) execution. */
export interface OwnerIdentity {
  role: string;
  workspaceId: string;
}
type GetOwnerRoleFn = (ownerUserId: string) => Promise<OwnerIdentity | null>;
type MintTokenFn = typeof mintOnBehalfToken;
type ExecuteFormFn = typeof executeFormAction;
type AutofillFn = typeof autofillForm;
type OriginFn = typeof resolveInternalOrigin;
/** Injectable fetch so the on-behalf operation call is stubbable in tests. */
type FetchFn = typeof fetch;

/**
 * Default owner-role resolver. Reads the OWNER's role + workspace from the
 * team-members table by id. NEVER elevates: the on-behalf token carries exactly
 * this role, so the downstream route enforces the owner's own capabilities. A
 * miss (no row / db down) returns null so the executor fails the step with a
 * clear error rather than guessing a role.
 */
async function defaultGetOwnerRole(
  ownerUserId: string,
): Promise<OwnerIdentity | null> {
  const { rows } = await safeQuery<{ role: string; workspace_id: string | null }>(
    `SELECT role, workspace_id FROM instinct_team_members WHERE id = $1 AND is_active = true`,
    [ownerUserId],
  );
  const row = rows[0];
  if (!row || !row.role) return null;
  return { role: row.role, workspaceId: row.workspace_id ?? "default" };
}

export interface ExecutorDeps {
  dispatch?: DispatchFn;
  notifyOwner?: NotifyFn;
  /** Inheritance: find a promoted procedure for this goal. */
  lookupProcedure?: LookupFn;
  /** Learning: record the plan a succeeded task ran. */
  recordProcedure?: RecordFn;
  /**
   * Brain grounding: consult org knowledge before an EXPLORING run spends
   * tokens. Best-effort and only invoked when the run is NOT inherited
   * (deterministic-first: a reused procedure never triggers Brain spend).
   */
  ground?: GroundFn;
  /**
   * Cost-aware model selection: which best-priced capable model an exploring
   * run would use. Pure + deterministic; invoked only when NOT inherited.
   */
  selectModel?: SelectModelFn;
  /** Records the model decision to analytics so no routing decision is lost. */
  logModelSelection?: LogModelSelectionFn;
  /**
   * Optional model pin for this agent. Threaded into the router so an agent can
   * insist on a specific model; absent means pure cost-based selection.
   */
  agentPin?: string;
  /* ---- On-behalf form execution deps (all stubbable for tests) ---- */
  /** Resolve the OWNER's role + workspace by id. Never elevated. */
  getOwnerRole?: GetOwnerRoleFn;
  /** Mint the short-lived on-behalf delegation token. */
  mintToken?: MintTokenFn;
  /** Drive the shared form executor with the minted token. */
  executeForm?: ExecuteFormFn;
  /** Deterministic form auto-fill from the instruction. */
  autofill?: AutofillFn;
  /** Resolve the trusted internal origin for server self-calls. */
  origin?: OriginFn;
  /**
   * Fetch implementation used for an on-behalf OPERATION call (the declarative
   * operation registry path). Defaults to the global fetch; tests stub it. The
   * minted on-behalf token is forwarded as the Authorization header and is
   * NEVER logged.
   */
  fetchImpl?: FetchFn;
  /**
   * Constitution applied to this run. Defaults to the bundled OGIAM Agent
   * Constitution; injectable so a test can assert the run is governed and the
   * applied event carries the right version.
   */
  constitution?: { version: string; text: string };
}

export interface RunResult {
  status: TaskStatus;
  steps: TaskStep[];
  resultSummary: string;
  /** True when the plan was inherited from shared memory (no re-exploration). */
  inherited: boolean;
}

function truncate(s: string, n = 240): string {
  const one = (s ?? "").replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

/**
 * RESULT-CHAINING bound. How many prior step outputs the executor carries
 * forward into the next step's dispatch context. Keeps the chained context
 * deterministic and small (each result string is already truncated by
 * `truncate`), so a long plan never balloons the dispatch payload. We keep the
 * MOST RECENT N, which is what a "summarize the results" style step needs.
 */
const PRIOR_RESULTS_CAP = 5;

/** True when a dispatch failure is the OGIAM enforce gate refusing the step. */
function isGateBlock(result: { ok: boolean; code?: string; message?: string }): boolean {
  return (
    !result.ok &&
    result.code === "capability" &&
    /OGIAM/.test(result.message ?? "")
  );
}

/** Outcome of a single on-behalf form execution. */
type OnBehalfOutcome =
  | { kind: "ran"; detail: string }
  | { kind: "blocked"; detail: string }
  | { kind: "error"; detail: string };

/**
 * Execute one form action AS THE OWNER. Auto-fills the form, escalates when a
 * required field is missing, resolves the owner's role (never elevated), mints a
 * fresh short-lived on-behalf token, and drives the shared form executor. Every
 * failure path (missing role, thrown mint, thrown execute, non-2xx response)
 * degrades to a typed outcome, so this never throws into the run loop.
 */
async function executeFormOnBehalf(args: {
  form: FormSpec;
  formKind: FormKind;
  instruction: string;
  parsedParams?: Record<string, unknown>;
  /**
   * Outputs of earlier steps in this task (result chaining). Threaded into the
   * deterministic auto-fill so a body-like field can be summarized FROM the
   * carried prior output when the instruction references it (e.g. "create a
   * feature summarizing the results"). Already capped + truncated upstream.
   */
  priorResults?: { instruction: string; result: string }[];
  task: ExecutableTask;
  deps: {
    getOwnerRole: GetOwnerRoleFn;
    mintToken: MintTokenFn;
    executeForm: ExecuteFormFn;
    autofill: AutofillFn;
    resolveOrigin: OriginFn;
  };
}): Promise<OnBehalfOutcome> {
  const { form, formKind, instruction, parsedParams, priorResults, task, deps } = args;
  try {
    const { values, missingRequired } = deps.autofill(
      form,
      instruction,
      parsedParams,
      priorResults,
    );
    if (missingRequired.length > 0) {
      return {
        kind: "blocked",
        detail: `Agent needs ${missingRequired.join(", ")} to complete ${formKind}`,
      };
    }

    // Resolve the OWNER's authority. Refuse rather than guess a role: a missing
    // owner identity must not become a default/elevated capability.
    const owner = await deps.getOwnerRole(task.ownerUserId);
    if (!owner) {
      return {
        kind: "error",
        detail: `Could not resolve the owner's role to act on their behalf for ${formKind}.`,
      };
    }

    // Mint a FRESH, short-lived delegation token per action (lib default TTL).
    // The token carries the OWNER's role only (never elevated) and is never
    // logged. The shared executor forwards it verbatim; the downstream route
    // enforces the owner's own capabilities.
    const token = await deps.mintToken({
      ownerUserId: task.ownerUserId,
      ownerRole: owner.role,
      workspaceId: owner.workspaceId,
      agentId: task.agentId,
    });

    const res = await deps.executeForm(formKind, values, {
      origin: deps.resolveOrigin(),
      authHeader: `Bearer ${token}`,
      /* agentId scopes the CRM-form connector resolution to the agent's bound
         set (least-privilege): submitCrmRecord reads it from extra. */
      extra: { workspaceId: owner.workspaceId, agentId: task.agentId },
    });

    if (res.status >= 200 && res.status < 300) {
      let message = `Completed ${formKind} on behalf of the owner.`;
      try {
        const body = (await res.json()) as { message?: unknown };
        if (typeof body.message === "string" && body.message.trim()) {
          message = body.message;
        }
      } catch {
        /* non-JSON 2xx is still a success; keep the generic summary */
      }
      return { kind: "ran", detail: message };
    }

    // Non-2xx: surface the executor's typed failure message when present.
    let detail = `Action failed (HTTP ${res.status}).`;
    try {
      const body = (await res.json()) as { message?: unknown };
      if (typeof body.message === "string" && body.message.trim()) detail = body.message;
    } catch {
      /* no JSON body; keep the status-based message */
    }
    return { kind: "error", detail };
  } catch (err) {
    // A thrown mint / executeForm / origin resolution degrades to an error step
    // so the run records a clear failure and never crashes.
    return { kind: "error", detail: `On-behalf execution failed: ${(err as Error).message}` };
  }
}

/** The operation descriptor an agent-only operation tool surfaces on success. */
interface OperationSpec {
  id: string;
  method: string;
  path: string;
  values: Record<string, unknown>;
  required: string[];
  /** Result-chaining target: a body field to fill from prior-step output. */
  fillFromPriorResults?: string;
}

function isEmptyValue(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === "string" && v.trim() === "");
}

/**
 * Execute one declarative platform OPERATION (the operation registry path) AS
 * THE OWNER. Mirrors executeFormOnBehalf exactly: escalates when a required
 * field is missing, resolves the OWNER's role (refusing rather than guessing /
 * elevating on a miss), mints a fresh short-lived on-behalf token carrying the
 * owner's role, and calls the underlying internal route with that token as the
 * Authorization bearer. The token is forwarded verbatim and NEVER logged. The
 * origin is the trusted server origin (never request-derived, CWE-918). Every
 * failure path (missing field, missing role, thrown mint/fetch, non-2xx) maps to
 * a typed outcome, so this never throws into the run loop.
 */
async function executeOperationOnBehalf(args: {
  operation: OperationSpec;
  /** The step instruction, used for the result-chaining reference check. */
  instruction: string;
  /** Carried output of earlier steps (already capped + truncated upstream). */
  priorResults?: { instruction: string; result: string }[];
  task: ExecutableTask;
  deps: {
    getOwnerRole: GetOwnerRoleFn;
    mintToken: MintTokenFn;
    resolveOrigin: OriginFn;
    fetchImpl: FetchFn;
  };
}): Promise<OnBehalfOutcome> {
  const { operation, instruction, priorResults, task, deps } = args;
  try {
    // RESULT CHAINING. A body field declared as fillFromPriorResults draws from
    // the carried prior-step output when the instruction refers back to it
    // ("create a document summary of the results") and the field is otherwise
    // empty. Reuses the exact form-path helpers, and runs BEFORE the required
    // gate so a chained body counts as filled instead of escalating.
    const fillField = operation.fillFromPriorResults;
    if (
      fillField &&
      isEmptyValue(operation.values[fillField]) &&
      referencesPriorOutput(instruction) &&
      priorResults &&
      priorResults.length > 0
    ) {
      const carried = summarizePriorResults(priorResults);
      if (carried) {
        operation.values = { ...operation.values, [fillField]: carried };
      }
    }

    // Required-field gate: an absent required value escalates to the owner
    // rather than calling the route with an invalid body.
    const missing = operation.required.filter((f) => isEmptyValue(operation.values[f]));
    if (missing.length > 0) {
      return {
        kind: "blocked",
        detail: `Agent needs ${missing.join(", ")} to complete ${operation.id}`,
      };
    }

    // Resolve the OWNER's authority. Refuse rather than guess a role: a missing
    // owner identity must not become a default/elevated capability.
    const owner = await deps.getOwnerRole(task.ownerUserId);
    if (!owner) {
      return {
        kind: "error",
        detail: `Could not resolve the owner's role to act on their behalf for ${operation.id}.`,
      };
    }

    // Mint a FRESH, short-lived delegation token carrying the OWNER's role only
    // (never elevated). Never logged. The downstream route enforces the owner's
    // own capabilities.
    const token = await deps.mintToken({
      ownerUserId: task.ownerUserId,
      ownerRole: owner.role,
      workspaceId: owner.workspaceId,
      agentId: task.agentId,
    });

    const method = operation.method.toUpperCase();
    // Route through the shared internalFetch so this on-behalf self-call gets
    // the Vercel deployment-protection bypass header, the transient-throw
    // retry, and the diagnosable error message (the fix for the prod
    // "On-behalf execution failed: fetch failed" bug). deps.fetchImpl is still
    // the injected transport (default global fetch; tests stub it), so the
    // existing test seams are preserved. The token is forwarded verbatim as
    // the Authorization bearer and is NEVER logged; the origin is the trusted
    // server origin (never request-derived, CWE-918).
    const res = await internalFetch(operation.path, {
      originOverride: deps.resolveOrigin(),
      fetchImpl: deps.fetchImpl,
      init: {
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: method === "GET" ? undefined : JSON.stringify(operation.values),
      },
    });

    if (res.status >= 200 && res.status < 300) {
      let detail = `Completed ${operation.id} on behalf of the owner.`;
      try {
        const body = (await res.json()) as {
          shortUrl?: unknown;
          fullRedirectUrl?: unknown;
          message?: unknown;
        };
        const target =
          typeof body.fullRedirectUrl === "string" && body.fullRedirectUrl.trim()
            ? body.fullRedirectUrl
            : typeof body.shortUrl === "string" && body.shortUrl.trim()
              ? body.shortUrl
              : undefined;
        if (target) {
          detail = `Completed ${operation.id}: ${target}`;
        } else if (typeof body.message === "string" && body.message.trim()) {
          detail = body.message;
        }
      } catch {
        /* non-JSON 2xx is still a success; keep the generic summary */
      }
      return { kind: "ran", detail };
    }

    // Non-2xx: include the HTTP status and any { error } body.
    let detail = `Operation failed (HTTP ${res.status}).`;
    try {
      const body = (await res.json()) as { error?: unknown; message?: unknown };
      const msg =
        typeof body.error === "string" && body.error.trim()
          ? body.error
          : typeof body.message === "string" && body.message.trim()
            ? body.message
            : undefined;
      if (msg) detail = `Operation failed (HTTP ${res.status}): ${msg}`;
    } catch {
      /* no JSON body; keep the status-based message */
    }
    return { kind: "error", detail };
  } catch (err) {
    // A thrown mint / fetch / origin resolution degrades to an error step so the
    // run records a clear failure and never crashes.
    return { kind: "error", detail: `On-behalf operation failed: ${(err as Error).message}` };
  }
}

export async function runAgentTask(
  task: ExecutableTask,
  deps: ExecutorDeps = {},
): Promise<RunResult> {
  const dispatch = deps.dispatch ?? tryDispatchTool;
  const notifyOwner = deps.notifyOwner ?? notify;
  const lookupProcedure = deps.lookupProcedure ?? findPromotedProcedure;
  const recordProcedure = deps.recordProcedure ?? recordLearnedProcedure;
  const ground = deps.ground ?? groundFromBrain;
  const chooseModel = deps.selectModel ?? selectModel;
  const recordModelChoice = deps.logModelSelection ?? logModelSelection;
  const getOwnerRole = deps.getOwnerRole ?? defaultGetOwnerRole;
  const mintToken = deps.mintToken ?? mintOnBehalfToken;
  const executeForm = deps.executeForm ?? executeFormAction;
  const autofill = deps.autofill ?? autofillForm;
  const resolveOrigin = deps.origin ?? resolveInternalOrigin;
  const fetchImpl = deps.fetchImpl ?? fetch;

  // Inheritance: reuse a promoted procedure for this goal instead of
  // re-exploring. Best effort: a memory miss or failure falls back to planning.
  let inherited = false;
  let instructions: string[];
  try {
    const prior = await lookupProcedure(task.workspaceId, task.goal, task.agentId);
    if (prior && prior.plan.length > 0) {
      instructions = prior.plan.map((p) => p.instruction);
      inherited = true;
    } else {
      instructions = getPlanner().plan(task.goal);
    }
  } catch {
    instructions = getPlanner().plan(task.goal);
  }

  const steps: TaskStep[] = [];
  let status: TaskStatus = "running";
  let blocked = false;
  let errored = false;

  // Maturation telemetry. An agent that deploys into a new system should get
  // MORE deterministic and CHEAPER over time: it reuses learned procedures (no
  // token consideration at all) and, only when it must explore, it grounds in
  // the Brain and picks the best-priced capable model. We record both so the
  // "familiarity / deterministic-vs-AI" curve is measurable run over run.
  let grounding: Grounding = { used: false, hits: 0, snippets: [] };
  let modelSelection: ModelSelection | undefined;

  // The OGIAM Agent Constitution that governs this run. Same operator rules the
  // assistant runs under, so behavior is consistent across every surface and
  // every model version. Injectable for tests.
  const constitution = deps.constitution ?? {
    version: CONSTITUTION_VERSION,
    text: getConstitution(),
  };

  const agentCtx: {
    userId: string;
    userRole: string;
    workspaceId: string;
    onBehalfOfUserId: string;
    agentPrincipal: {
      agentId: string;
      role: string;
      workspaceId: string;
      ownerUserId: string;
    };
    constitution: { version: string; text: string };
    /** Template guidance (success criteria, context, target) for this run. */
    guidance?: string;
    grounding?: { snippets: string[] };
    priorResults?: { instruction: string; result: string }[];
  } = {
    userId: task.agentId,
    userRole: task.role,
    workspaceId: task.workspaceId,
    // A form-returning tool builds its owner-scoped options (e.g. the To-Do list
    // dropdown) for the OWNER, so the form carries a real default the generic
    // executor can submit on the owner's behalf.
    onBehalfOfUserId: task.ownerUserId,
    agentPrincipal: {
      agentId: task.agentId,
      role: task.role,
      workspaceId: task.workspaceId,
      ownerUserId: task.ownerUserId,
    },
    constitution,
    ...(task.guidance ? { guidance: task.guidance } : {}),
  };

  // Record that this run is constitution-governed so the signal is in the
  // learning loop and visible in the agent's log. Fire-and-forget.
  trackEvent("agent.constitution_applied", task.agentId, task.role, {
    agent_id: task.agentId,
    task_id: task.id,
    constitution_version: constitution.version,
    workspace_id: task.workspaceId,
  });

  // DETERMINISTIC-FIRST. Only an EXPLORING run (no inherited procedure) ever
  // considers tokens. A reused procedure is free: we deliberately do NOT ground
  // against the Brain and do NOT consult the cost-aware router, so reuse never
  // triggers any token spend or model decision. This is the cost plateau made
  // concrete.
  if (!inherited) {
    // Best-effort grounding. A Brain/embedder hiccup never throws here
    // (groundFromBrain swallows failures) and never blocks the task: on any
    // failure we keep the empty grounding and run ungrounded.
    try {
      grounding = await ground(task.goal, task.workspaceId, {
        userId: task.agentId,
        userRole: task.role,
      });
    } catch {
      /* grounding is a best-effort speedup; the task still runs ungrounded */
    }
    if (grounding.snippets.length > 0) {
      // Hand org knowledge to AI-backed tools so they spend fewer tokens.
      // Deterministic tools ignore this field.
      agentCtx.grounding = { snippets: grounding.snippets };
    }

    // Cost-aware model selection. selectModel is pure + never throws, but we
    // still guard the whole block so a router/analytics hiccup can never break
    // or slow the task beyond this best-effort call.
    try {
      modelSelection = chooseModel({
        requiredTier: "large",
        agentPin: deps.agentPin,
      });
      recordModelChoice(modelSelection, {
        userId: task.agentId,
        userRole: task.role,
        extra: { task_id: task.id, brain_grounded: grounding.used },
      });
    } catch {
      /* model routing is best effort; the task runs regardless */
    }
  }

  // RESULT-CHAINING accumulator. Ordered outputs of the steps that already ran,
  // carried forward so a later step can consume an earlier one's output (e.g.
  // "search the web for X; create a feature summarizing the results"). Bounded to
  // the most recent PRIOR_RESULTS_CAP entries; each result is the truncated step
  // answer, so the carried context stays small and deterministic. Nothing
  // sensitive beyond the already-truncated answers is ever added.
  const priorResults: { instruction: string; result: string }[] = [];

  // Record one completed step's output for later steps to chain on. `result` is
  // the already-truncated step detail/answer, so no payload growth; the list is
  // clamped to the most recent PRIOR_RESULTS_CAP entries.
  const recordPriorResult = (stepInstruction: string, result: string): void => {
    priorResults.push({ instruction: stepInstruction, result });
    if (priorResults.length > PRIOR_RESULTS_CAP) {
      priorResults.splice(0, priorResults.length - PRIOR_RESULTS_CAP);
    }
  };

  for (let i = 0; i < instructions.length; i++) {
    const instruction = instructions[i];
    // Expose the prior steps' outputs to THIS dispatch. A shallow copy so a tool
    // (or the form path below) cannot mutate the accumulator. Set only when there
    // is something to carry, so a normal first step looks exactly as before.
    agentCtx.priorResults =
      priorResults.length > 0 ? priorResults.slice() : undefined;

    let res;
    try {
      res = await dispatch(instruction, agentCtx);
    } catch (err) {
      steps.push({ index: i, instruction, tool: null, outcome: "error", detail: truncate((err as Error).message) });
      status = "failed";
      break;
    }

    if (res === null) {
      steps.push({ index: i, instruction, tool: null, outcome: "no_match", detail: "no tool matched this instruction" });
      continue;
    }

    const r = res.result;
    if (isGateBlock(r)) {
      steps.push({ index: i, instruction, tool: res.tool, outcome: "blocked", detail: truncate((r as { message: string }).message) });
      blocked = true;
      // Escalate to the accountable human owner for approval.
      try {
        await notifyOwner({
          userId: task.ownerUserId,
          category: "agent",
          priority: "high",
          title: "Agent action needs your approval",
          body: `Agent ${task.agentId} was stopped on: ${truncate(instruction, 120)}`,
          actionUrl: `/admin/agents/${task.agentId}`,
          actionLabel: "Review agent",
          source: "agent_task",
          sourceId: task.id,
          metadata: { agent_id: task.agentId, task_id: task.id, step: i },
          dedup: true,
        });
      } catch {
        /* escalation is best effort; the block already stands */
      }
      break;
    }

    if (r.ok) {
      // GENERIC AGENT FORM EXECUTION. A successful result that surfaces a FORM
      // is a structured action a human would normally fill + submit. An agent
      // cannot click a UI, so we auto-fill the form deterministically from the
      // instruction and execute it AS THE OWNER through the secure on-behalf
      // token + the shared form executor. No per-workflow code: every
      // form-returning tool flows through this one path. (Replaces the old
      // "form -> error" honesty branch: the action now actually runs.)
      const form = (r as { form?: FormSpec }).form;
      const dataFormKind = (r as { data?: { formKind?: unknown } }).data?.formKind;
      if (form) {
        const formKind =
          typeof dataFormKind === "string" ? dataFormKind : form.formKind;
        if (!KNOWN_FORM_KINDS.includes(formKind as FormKind)) {
          steps.push({ index: i, instruction, tool: res.tool, outcome: "error", detail: truncate(`unsupported form kind for agent execution: ${String(formKind)}`) });
          errored = true;
          break;
        }
        const outcome = await executeFormOnBehalf({
          form,
          formKind: formKind as FormKind,
          instruction,
          // The dispatcher's result does not expose the tool's parsed params, so
          // we pass undefined; the FormSpec defaults + the deterministic
          // instruction extraction still cover the common cases (e.g. title).
          parsedParams: undefined,
          // Result chaining: hand the prior steps' outputs to the auto-fill so a
          // body-like field gets summarized from them when the instruction
          // references prior output (e.g. "summarizing the results").
          priorResults: agentCtx.priorResults,
          task,
          deps: {
            getOwnerRole,
            mintToken,
            executeForm,
            autofill,
            resolveOrigin,
          },
        });
        if (outcome.kind === "blocked") {
          steps.push({ index: i, instruction, tool: res.tool, outcome: "blocked", detail: truncate(outcome.detail) });
          blocked = true;
          try {
            await notifyOwner({
              userId: task.ownerUserId,
              category: "agent",
              priority: "high",
              title: "Agent needs your input to finish",
              body: outcome.detail,
              actionUrl: `/admin/agents/${task.agentId}`,
              actionLabel: "Review agent",
              source: "agent_task",
              sourceId: task.id,
              metadata: { agent_id: task.agentId, task_id: task.id, step: i, form_kind: formKind },
              dedup: true,
            });
          } catch {
            /* escalation is best effort; the block already stands */
          }
          break;
        }
        if (outcome.kind === "error") {
          steps.push({ index: i, instruction, tool: res.tool, outcome: "error", detail: truncate(outcome.detail) });
          errored = true;
          break;
        }
        // Ran on behalf of the owner. One analytics row per delegated action so
        // no on-behalf execution is lost to the learning loop. agent.acted is
        // the existing event for "the agent drove a tool dispatch as itself".
        try {
          trackEvent("agent.acted", task.agentId, task.role, {
            agent_id: task.agentId,
            tool: res.tool,
            allowed: true,
            on_behalf_of_owner: true,
            form_kind: formKind,
            task_id: task.id,
          });
        } catch {
          /* telemetry is best effort; the action already ran */
        }
        {
          const detail = truncate(outcome.detail);
          steps.push({ index: i, instruction, tool: res.tool, outcome: "ran", detail });
          recordPriorResult(instruction, detail);
        }
        continue;
      }

      // GENERIC AGENT OPERATION EXECUTION. A successful result that surfaces an
      // `operation` is a declarative platform call (the operation registry) the
      // agent should make on its owner's behalf. Like the form path above, no
      // per-operation code: every operation flows through this one branch, which
      // mints a fresh owner-scoped on-behalf token and invokes the route. NEW
      // operations are a few declarative lines in operations/registry.ts.
      const operation = (r as { operation?: OperationSpec }).operation;
      if (operation) {
        const outcome = await executeOperationOnBehalf({
          operation,
          instruction,
          // Result chaining: hand the prior steps' outputs to the operation so a
          // body field (e.g. a document summary) gets filled from them when the
          // instruction references prior output.
          priorResults: agentCtx.priorResults,
          task,
          deps: { getOwnerRole, mintToken, resolveOrigin, fetchImpl },
        });
        if (outcome.kind === "blocked") {
          steps.push({ index: i, instruction, tool: res.tool, outcome: "blocked", detail: truncate(outcome.detail) });
          blocked = true;
          try {
            await notifyOwner({
              userId: task.ownerUserId,
              category: "agent",
              priority: "high",
              title: "Agent needs your input to finish",
              body: outcome.detail,
              actionUrl: `/admin/agents/${task.agentId}`,
              actionLabel: "Review agent",
              source: "agent_task",
              sourceId: task.id,
              metadata: { agent_id: task.agentId, task_id: task.id, step: i, operation_id: operation.id },
              dedup: true,
            });
          } catch {
            /* escalation is best effort; the block already stands */
          }
          break;
        }
        if (outcome.kind === "error") {
          steps.push({ index: i, instruction, tool: res.tool, outcome: "error", detail: truncate(outcome.detail) });
          errored = true;
          break;
        }
        // Ran on behalf of the owner. One analytics row per delegated operation
        // so no on-behalf execution is lost to the learning loop.
        try {
          trackEvent("agent.acted", task.agentId, task.role, {
            agent_id: task.agentId,
            tool: res.tool,
            allowed: true,
            on_behalf_of_owner: true,
            operation_id: operation.id,
            task_id: task.id,
          });
        } catch {
          /* telemetry is best effort; the operation already ran */
        }
        {
          const detail = truncate(outcome.detail);
          steps.push({ index: i, instruction, tool: res.tool, outcome: "ran", detail });
          recordPriorResult(instruction, detail);
        }
        continue;
      }

      {
        const detail = truncate((r as { answer: string }).answer);
        steps.push({ index: i, instruction, tool: res.tool, outcome: "ran", detail });
        recordPriorResult(instruction, detail);
      }
    } else {
      // A tool-level failure (not a gate block) is a real error: record it and
      // stop acting. A task whose step errored has NOT succeeded.
      steps.push({ index: i, instruction, tool: res.tool, outcome: "error", detail: truncate((r as { message: string }).message) });
      errored = true;
      break;
    }
  }

  const ran = steps.filter((s) => s.outcome === "ran").length;
  // Honest terminal status. Blocked (a governance escalation) takes precedence.
  // A real tool error fails the task, and a task where NOTHING ran never counts
  // as success (the bug that showed "Succeeded / Completed 0 of 1 step"). A
  // partial run where at least one step ran and none errored is a success with
  // the honest step count in the summary.
  if (status !== "failed") {
    if (blocked) status = "blocked";
    else if (errored) status = "failed";
    else if (ran === 0) status = "failed";
    else status = "succeeded";
  }

  // Learning: a freshly-explored, fully-successful plan becomes a candidate
  // procedure (the safety check inside recordProcedure decides if it is shareable
  // and never lets an unsafe plan be inherited). We do not re-record an inherited
  // plan. Best effort: learning never breaks the task.
  if (status === "succeeded" && !inherited) {
    try {
      await recordProcedure({
        workspaceId: task.workspaceId,
        goal: task.goal,
        plan: steps.map((s) => ({ instruction: s.instruction, tool: s.tool })),
        learnedByAgent: task.agentId,
        sourceTaskId: task.id,
      });
    } catch {
      /* learning is best effort; the task already ran */
    }
  }

  const resultSummary = blocked
    ? `Stopped for approval after ${ran} step(s).`
    : status === "failed"
      ? ran === steps.length && steps.length > 0
        ? "Failed during execution."
        : `Failed: completed ${ran} of ${steps.length} step(s).`
      : `Completed ${ran} of ${steps.length} step(s).`;

  const brainGrounded = grounding.snippets.length > 0;
  const modelId = modelSelection?.model.id;
  const estCostUsd = modelSelection?.estimatedCostUsd;

  // Maturation telemetry on the existing completion event: `inherited`,
  // `brain_grounded`, and `model_id` make the deterministic-vs-AI / familiarity
  // curve queryable over time without a new join. Inherited (deterministic)
  // runs carry brain_grounded:false and no model_id by construction.
  trackEvent("agent.task_completed", task.agentId, task.role, {
    agent_id: task.agentId,
    task_id: task.id,
    status,
    step_count: steps.length,
    ran_count: ran,
    blocked,
    inherited,
    brain_grounded: brainGrounded,
    ...(modelId ? { model_id: modelId } : {}),
  });

  // Dedicated grounding/maturation event so the familiarity curve has its own
  // namespace independent of task outcome. Best-effort: never breaks the task.
  try {
    trackEvent("agent.execution_grounded", task.agentId, task.role, {
      agent_id: task.agentId,
      task_id: task.id,
      inherited,
      brain_hits: grounding.hits,
      brain_grounded: brainGrounded,
      ...(modelId ? { model_id: modelId } : {}),
      ...(typeof estCostUsd === "number" ? { est_cost_usd: estCostUsd } : {}),
    });
  } catch {
    /* telemetry is best effort; the task already ran */
  }

  return { status, steps, resultSummary, inherited };
}

/**
 * Familiarity score for a sequence of runs: the fraction (0..1) that reused a
 * deterministic learned procedure instead of exploring. As an agent matures in
 * a system this trends toward 1 (more deterministic, cheaper). A future surface
 * can chart it directly. Empty history scores 0 (no familiarity yet). Pure.
 */
export function familiarityScore(history: { inherited: boolean }[]): number {
  if (!history || history.length === 0) return 0;
  const reused = history.filter((h) => h.inherited).length;
  return reused / history.length;
}
