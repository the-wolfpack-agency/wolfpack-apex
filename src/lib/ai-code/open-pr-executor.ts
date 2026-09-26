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
import { workspaceGithubClient, createBranch, putFile, openPullRequest } from "@/lib/github-client";
import { authorize } from "@/lib/ogiam/authorize";
import { newFilesFromDiff } from "./oracle";

export interface OpenPrParams {
  /** target repo "owner/name". Defaults to apex (self-hosting) when absent. */
  repo?: string;
  /** the run ref / task id, used in the branch name + PR title. */
  ref?: string;
  /** the gate-approved unified diff. */
  diff?: string;
  /** the originating prompt, for the PR title/body. */
  prompt?: string;
  /** base branch to target. Defaults to main. */
  base?: string;
}

export type WriteCtx = { userId: string; userRole: string; workspaceId?: string; agentId?: string };
export type OpenPrOutcome =
  | { ok: true; url: string; number: number; branch: string; files: number }
  | { ok: false; reason: string };

const DEFAULT_REPO = process.env.FACTORY_TARGET_REPO || "the-wolfpack-agency/wolfpack-apex";

function sanitizeRef(ref: string): string {
  return (ref || "change").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "change";
}

export async function executeOpenPr(params: OpenPrParams, ctx: WriteCtx): Promise<OpenPrOutcome> {
  const diff = typeof params.diff === "string" ? params.diff : "";
  const files = newFilesFromDiff(diff);
  const paths = Object.keys(files);
  if (paths.length === 0) {
    return { ok: false, reason: "Stage 1 opens PRs for new-file changes only, and this diff creates no new files" };
  }

  const repo = params.repo || DEFAULT_REPO;
  const base = params.base || "main";
  const ref = sanitizeRef(params.ref || "change");
  // Deterministic, unique-per-change branch: no clock, so the same diff always
  // maps to the same branch (a retried approval reuses it rather than forking).
  const hash = createHash("sha256").update(diff).digest("hex").slice(0, 8);
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
  if (decision.enforced && decision.effectiveOutcome !== "allow") {
    return { ok: false, reason: `gate_blocked: ${decision.ruleId} (${decision.reason})` };
  }

  const client = await workspaceGithubClient(ctx.workspaceId);
  if (!client.token) return { ok: false, reason: "no GitHub token configured for the factory" };

  try {
    await createBranch(client, repo, branch, base);
    for (const path of paths) {
      await putFile(client, repo, path, files[path], `factory: ${ref} (${path})`, branch);
    }
    const title = `factory: ${(params.prompt || ref).replace(/\s+/g, " ").trim().slice(0, 72)}`;
    const body = [
      "Authored by the Instinct code factory and submitted through Instinct.",
      "",
      `- ref: ${ref}`,
      `- files: ${paths.map((p) => `\`${p}\``).join(", ")}`,
      "",
      "This change passed the deterministic security gate + engineering invariants and a human approved the handoff. A human still reviews and merges this PR; the factory never merges.",
    ].join("\n");
    const pr = await openPullRequest(client, repo, branch, base, title, body);
    return { ok: true, url: pr.html_url, number: pr.number, branch, files: paths.length };
  } catch (err) {
    // Never throw from an approved-write executor: a recorded ok:false is the
    // audited outcome; a throw would lose the reason.
    return { ok: false, reason: (err as Error).message };
  }
}
