/**
 * Agent task model. A human assigns work to an agent the same way work is
 * assigned to a teammate; the agent runs it as a governed multi-step plan, each
 * step authorized by OGIAM under the agent's own identity.
 */

export type TaskStatus =
  | "queued" // assigned, not started
  | "running"
  | "succeeded" // every step ran
  | "blocked" // a step was refused by the gate; the owner was asked to approve
  | "failed"; // an unexpected error

export type StepOutcome =
  | "ran" // the tool ran
  | "blocked" // OGIAM refused this step (enforce mode)
  | "no_match" // no tool matched the instruction
  | "error";

export interface TaskStep {
  index: number;
  instruction: string;
  /** Tool the dispatcher chose, when one matched. */
  tool: string | null;
  outcome: StepOutcome;
  /** Short human-readable detail (the answer, the refusal reason, etc.). */
  detail: string;
  /** Workspace-internal URL of a visual artifact (e.g. a captured screenshot)
   *  the step produced; the agent-run UI renders it as a thumbnail. */
  imageUrl?: string;
}

export interface AgentTask {
  id: string;
  agentId: string;
  workspaceId: string;
  assignedBy: string;
  goal: string;
  /** Structured template fields (migration 219). Null on legacy goal-only rows. */
  successCriteria: string | null;
  context: string | null;
  targetConnectionId: string | null;
  /** Origin surface: detail_page | chat_widget | api. */
  source: string | null;
  status: TaskStatus;
  steps: TaskStep[];
  resultSummary: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/**
 * A planner turns a goal into ordered sub-goal instructions. Pluggable: the
 * deterministic IntentPlanner splits the goal now (no LLM, fully testable), and
 * an LLM planner can swap in later behind the same interface without changing
 * the executor or its governance.
 */
export interface AgentPlanner {
  readonly kind: string;
  plan(goal: string): string[];
}
