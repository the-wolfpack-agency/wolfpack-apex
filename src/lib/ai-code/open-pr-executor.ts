/**
 * The approved-write executor for ai_code.open_pr - the step that turns a
 * factory run into a REAL pull request, so work is submitted through Instinct
 * instead of an IDE.
 *
 * Stage 1 scope: NEW-FILE changes. The authored diff's created files are
 * committed to a fresh branch and a PR is opened for human review. It never
 * merges (a PR is the review checkpoint), and it runs only after the run passed
 * the security gate + engineering invariants and a human approved the handoff -
 * this is the execution half of that approval.
 *
 * A modification-heavy diff (edits to existing files) creates no NEW files, so
 * it returns a clear ok:false rather than a partial commit - full edit fidelity
 * is the git-workspace stage, not this one.
 */
import { createHash } from "node:crypto";
import { workspaceGithubClient, openPullRequest } from "@/lib/github-client";
import { authorize } from "@/lib/ogiam/authorize";
import { recordActionOutcome } from "@/lib/ogiam/ledger";
import { trackEvent } from "@/lib/analytics";
import { newFilesFromDiff } from "./oracle";
import { commitFileChanges, type FileChange } from "./file-changes";
import { pushValidationBranch } from "./pre-pr-validation";
import { prePrValidateGate } from "@/lib/gates/pre-pr-validate-gate";
import { runGate } from "@/lib/gates/run-gate";
import { DEFAULT_COMPLIANCE_POLICY } from "@/lib/gates/types";

export interface OpenPrParams {
  /** target repo "owner/name". Defaults to apex (self-hosting) when absent. */
  repo?: string;
  /** the run ref / task id, used in the branch name + PR title. */
  ref?: string;
  /** the gate-approved unified diff (new-file mode). */
  diff?: string;
  /** the gate-approved FULL file contents (edit-support mode). Takes precedence
   *  over diff when present, and can commit modifications, not just new files. */
  changes?: FileChange[];
  /** the originating prompt, for the PR title/body. */
  prompt?: string;
  /** base branch to target. Defaults to main. */
  base?: string;
}

export type WriteCtx = { userId: string; userRole: string; workspaceId?: string; agentId?: string; approvalId?: string };
export type OpenPrOutcome =
  | { ok: true; url: string; number: number; branch: string; files: number }
  // On a failure AFTER the branch was pushed, we still hand back the branch + a
  // one-click compare link so the pushed work is never lost and a human can open
  // the PR themselves (e.g. when the token lacks pull_requests: write).
  // needsInstall marks the permission case specifically, so the UI can offer the
  // one-click GitHub App install (the true minimum-effort fix) rather than a PAT.
  | { ok: false; reason: string; branch?: string; files?: number; compareUrl?: string; needsInstall?: boolean };

const DEFAULT_REPO = process.env.FACTORY_TARGET_REPO || "the-wolfpack-agency/wolfpack-apex";

function sanitizeRef(ref: string): string {
  return (ref || "change").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "change";
}

/**
 * Derive the file changes to commit from the approved params. Full file contents
 * (new OR modified) take precedence; else fall back to the new files extracted
 * from the diff. Either way we commit full contents via commitFileChanges - no
 * patch application. Shared by executeOpenPr and validateBeforePr so the two
 * always validate + commit the EXACT same change set (DRY).
 */
export function changesFromParams(params: OpenPrParams): FileChange[] {
  const diff = typeof params.diff === "string" ? params.diff : "";
  return params.changes && params.changes.length > 0
    ? params.changes
    : Object.entries(newFilesFromDiff(diff)).map(([path, content]) => ({ path, content }));
}

export interface PrePrValidationResult {
  /** "allow" = safe to open the PR; "require_human" = not green yet (still
   *  validating) or failed (self-inconsistent / convention violation). */
  verdict: "allow" | "require_human";
  status: string;
  failing: string[];
  branch?: string;
  reason: string;
}

/**
 * Tier-2 pre-PR validation: push the authored change to a throwaway branch and
 * run the TARGET REPO's OWN gate (factory-validate = the repo's full verify)
 * against it BEFORE a real PR is opened. Catches a convention violation (e.g.
 * raw-fetch, missing auth) or a self-inconsistent artifact at the source, using
 * the repo's own rules - so it never over-fits the shared gate to one client.
 *
 * Opt-in via PREPR_VALIDATE_WORKFLOW: a no-op "allow" when unset, so the existing
 * approve->open-PR flow is byte-identical until a deployment turns it on. Reuses
 * the built pushValidationBranch + prePrValidateGate via runGate (DRY - there is
 * no second validator).
 */
export async function validateBeforePr(params: OpenPrParams, ctx: WriteCtx): Promise<PrePrValidationResult> {
  if (!process.env.PREPR_VALIDATE_WORKFLOW) {
    return { verdict: "allow", status: "not_enforced", failing: [], reason: "pre-PR validation not enabled" };
  }
  const changes = changesFromParams(params);
  if (changes.length === 0) {
    // Nothing to validate; executeOpenPr returns the authoritative "no file
    // changes" error, so let it proceed (allow) to keep that error singular.
    return { verdict: "allow", status: "no_changes", failing: [], reason: "no file changes to validate" };
  }
  const repo = params.repo || DEFAULT_REPO;
  const base = params.base || "main";
  const ref = sanitizeRef(params.ref || "change");
  const client = await workspaceGithubClient(ctx.workspaceId);
  if (!client.token) {
    return { verdict: "require_human", status: "no_token", failing: [], reason: "no GitHub token configured for pre-PR validation" };
  }
  let branch: string;
  try {
    branch = await pushValidationBranch(client, repo, changes, base, ref);
  } catch (err) {
    return { verdict: "require_human", status: "push_failed", failing: [], reason: `could not push validation branch: ${(err as Error).message}` };
  }
  const result = await runGate(prePrValidateGate, { repo, branch, base }, {
    workspaceId: ctx.workspaceId ?? "default",
    actorId: ctx.userId,
    policy: DEFAULT_COMPLIANCE_POLICY,
  });
  const out = result.output ?? { status: "unknown", failing: [] as string[] };
  return {
    verdict: result.verdict === "allow" ? "allow" : "require_human",
    status: out.status,
    failing: out.failing ?? [],
    branch,
    reason: result.reason,
  };
}

export async function executeOpenPr(params: OpenPrParams, ctx: WriteCtx): Promise<OpenPrOutcome> {
  // Edit-support: full file contents (new OR modified) take precedence; else fall
  // back to the new files extracted from the diff. Either way we commit full
  // contents via commitFileChanges - no patch application.
  const changes: FileChange[] = changesFromParams(params);
  if (changes.length === 0) {
    return { ok: false, reason: "no file changes to commit (a modification-only diff needs full-file changes)" };
  }

  const repo = params.repo || DEFAULT_REPO;
  const base = params.base || "main";
  const ref = sanitizeRef(params.ref || "change");
  // Deterministic, unique-per-change branch: hash the exact content committed, so
  // the same change always maps to the same branch (a retried approval reuses it).
  const hash = createHash("sha256").update(JSON.stringify(changes)).digest("hex").slice(0, 8);
  const branch = `factory/${ref}-${hash}`;

  // Governed like every other agent write: run the PR-open through the OGIAM
  // gate + hash-chained ledger, exactly as platform-scan remediation does (DRY -
  // reuse the PEP, do not reinvent one). Monitor mode in Phase 0 records the
  // decision without blocking; an enforce-mode block short-circuits before any
  // write. This puts factory actions in the same governance surfaces as the rest.
  const decision = await authorize({
    principal: {
      kind: "ai_agent",
      agent: "instinct.ai_code",
      onBehalfOfUserId: ctx.userId,
      onBehalfOfRole: ctx.userRole,
      workspaceId: ctx.workspaceId ?? "default",
    },
    tool: "ai_code.open_pr",
    capability: "code.write",
    isMutation: true,
    surface: "/agent",
    params: { repo, branch, ref },
    mode: "monitor",
  });
  const startMs = Date.now();
  // Close the ledger loop: every decision gets an OUTCOME tied to its seq, so the
  // record is "what was decided AND what happened", not just the decision. Best
  // effort + only when the decision was actually recorded (recordedSeq present).
  const recordOutcome = async (ok: boolean, code: string, result: string): Promise<void> => {
    if (decision.recordedSeq == null) return;
    await recordActionOutcome({
      workspaceId: ctx.workspaceId ?? "default",
      decisionSeq: decision.recordedSeq,
      agentId: "instinct.ai_code",
      ok,
      code,
      resultRedacted: result,
      durationMs: Date.now() - startMs,
    }).catch(() => {});
  };

  if (decision.enforced && decision.effectiveOutcome !== "allow") {
    await recordOutcome(false, "gate_blocked", `${decision.ruleId}: ${decision.reason}`);
    return { ok: false, reason: `gate_blocked: ${decision.ruleId} (${decision.reason})` };
  }

  const client = await workspaceGithubClient(ctx.workspaceId);
  if (!client.token) {
    await recordOutcome(false, "no_token", "no GitHub token configured");
    return { ok: false, reason: "no GitHub token configured for the factory" };
  }

  try {
    const committed = await commitFileChanges({ client, repoFullName: repo, branch, base, changes, message: `factory: ${ref}` });
    const title = `factory: ${(params.prompt || ref).replace(/\s+/g, " ").trim().slice(0, 72)}`;
    const body = [
      "Opened by AgentGate AI, the OGIAM code gate. Authored by a model, gated deterministically, and submitted for human review.",
      "",
      `- ref: ${ref}`,
      `- files: ${committed.map((p) => `\`${p}\``).join(", ")}`,
      "",
      "This change passed the deterministic security gate + engineering invariants and a human approved the handoff. A human still reviews and merges this PR; the factory never merges.",
    ].join("\n");
    try {
      const pr = await openPullRequest(client, repo, branch, base, title, body);
      await recordOutcome(true, "ok", pr.html_url);
      // MISSION outcome: a reviewable PR was actually produced (not just gated).
      void trackEvent("ai_code.pr_opened", ctx.userId, ctx.userRole, { repo, pr_number: pr.number, files: committed.length, branch, ...(ctx.approvalId ? { approval_id: ctx.approvalId } : {}) });
      return { ok: true, url: pr.html_url, number: pr.number, branch, files: committed.length };
    } catch (prErr) {
      // The branch + commit LANDED, but opening the PR failed - most commonly a
      // token without `pull_requests: write` on the repo (a 403). Do not lose the
      // pushed work: hand back a one-click compare link so a human can open the PR,
      // plus an actionable reason (install the App / grant the scope). Minimum
      // client effort, and the generated code is safe on the branch either way.
      const msg = (prErr as Error).message;
      // Branch + base are already safe path segments (sanitizeRef limits the ref
      // to [A-Za-z0-9._-]); do NOT encode the "/" in "factory/..." or the compare
      // link breaks.
      const compareUrl = `https://github.com/${repo}/compare/${base}...${branch}?expand=1`;
      const permission = /403|not accessible|pull_requests|forbidden/i.test(msg);
      const reason = permission
        ? `The change was pushed to branch "${branch}", but this GitHub token cannot open pull requests on ${repo}. Install the Instinct GitHub App (or grant the token Pull requests: write), then open the PR from the compare link.`
        : `The change was pushed to branch "${branch}", but opening the pull request failed: ${msg}`;
      await recordOutcome(false, permission ? "pr_permission" : "pr_open_error", `${reason} | ${compareUrl}`);
      return { ok: false, reason, branch, files: committed.length, compareUrl, needsInstall: permission };
    }
  } catch (err) {
    // Never throw from an approved-write executor: a recorded ok:false is the
    // audited outcome; a throw would lose the reason.
    await recordOutcome(false, "github_error", (err as Error).message);
    return { ok: false, reason: (err as Error).message };
  }
}
