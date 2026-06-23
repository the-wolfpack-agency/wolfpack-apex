/**
 * Shared agent procedural memory types. A learned procedure is a goal plus the
 * plan that worked, keyed by a normalized goal so a later agent can reuse it.
 */

export type MemoryStatus = "quarantined" | "promoted" | "rejected";

/** One step of a learned plan: the instruction and the tool that ran it. */
export interface ProcedureStep {
  instruction: string;
  tool: string | null;
}

export interface MemoryEntry {
  id: string;
  workspaceId: string;
  goalKey: string;
  goal: string;
  plan: ProcedureStep[];
  status: MemoryStatus;
  learnedByAgent: string;
  sourceTaskId: string | null;
  hitCount: number;
  rejectReason: string | null;
  createdAt: string;
  verifiedAt: string | null;
}
