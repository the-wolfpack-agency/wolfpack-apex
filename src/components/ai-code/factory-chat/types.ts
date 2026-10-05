/**
 * Factory Chat - a self-contained, chat-centric view of the Secure Agent pipeline.
 *
 * EXTRACTION BOUNDARY: this folder has no Instinct-specific coupling. All data
 * access goes through the one client (client.ts) against the existing pipeline /
 * approvals / ci endpoints. To lift this into the standalone Code Factory repo,
 * move src/components/ai-code/factory-chat/* + repoint FACTORY_API_BASE. Nothing
 * else here imports from the Instinct dashboard.
 */

/** A client-facing checkpoint. We show the OUTCOME, never the detector internals. */
export type CheckpointStatus = "pending" | "clear" | "blocked" | "held";
export interface Checkpoint {
  id: string;
  label: string;
  status: CheckpointStatus;
  /** One short, client-safe line. Never a rule pattern or detector mechanism. */
  detail?: string;
}

/** The subset of the pipeline response the chat renders (presentation only). */
export interface PipelineResult {
  run?: { status?: string; diff?: string } | null;
  approvalId?: string | null;
  executor?: { author?: string; provider?: string; error?: string | null } | null;
  executorAttempts?: number | null;
  invariants?: { wouldBlock?: boolean } | null;
  deepScan?: { blocking?: boolean; critical?: number; high?: number } | null;
  duplication?: { escalate?: boolean } | null;
  syntax?: { ok?: boolean } | null;
  phantomImports?: unknown[] | null;
  incompleteFiles?: unknown[] | null;
  removedExports?: unknown[] | null;
  anchorFailures?: unknown[] | null;
  brokenLocalImports?: unknown[] | null;
  mode?: string | null;
  cost?: { usd?: number } | null;
}

export interface CiCategoryLite {
  key: string;
  label: string;
  status: "pass" | "fail" | "pending" | "absent";
}
export interface CiDashboardLite {
  categories: CiCategoryLite[];
  overall: "pass" | "fail" | "pending" | "absent";
}

/** A rendered turn in the conversation. */
export interface ChatTurn {
  id: string;
  prompt: string;
  phase: "running" | "gated" | "awaiting-human" | "pr-open" | "error";
  result?: PipelineResult;
  approvalId?: string | null;
  ci?: CiDashboardLite;
  model?: { name: string; escalated: boolean };
  prUrl?: string;
  notARequest?: boolean;
  previewUrl?: string;
  deployedUrl?: string;
  error?: string;
}

/** An open factory PR with everything the in-tool approval surface shows. Mirrors
 *  the server's PullApprovalStatus (kept local so the module stays self-contained
 *  for the standalone extraction). */
export interface OpenPullStatus {
  repo: string;
  number: number;
  title: string;
  url: string;
  branch: string;
  base: string;
  ciGreen: boolean;
  ciReadable: boolean;
  gateOutcome: "allow" | "escalate" | "block" | "unknown";
  touchesSensitiveSurface: boolean;
  hasTests: boolean;
  fileCount: number;
  eligible: boolean;
  eligibilityReason: string;
}
