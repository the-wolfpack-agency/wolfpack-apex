/**
 * POST /api/admin/ai-code/ci-fix  { repo, ref, branch?, attempt?, maxAttempts? }
 *
 * One step of the read-CI-and-fix-until-green loop for a factory PR.
 *
 *  - Without `branch`: DECIDE only (merge_ready / wait / author_fix /
 *    escalate_human) and, when a fix is due, return the brief. Legacy behavior.
 *  - With `branch`: DRIVE it. On a red CI with budget left, re-author the fix and
 *    COMMIT it to the PR branch (which re-triggers CI). A poller / webhook calls
 *    this repeatedly until `terminal` is true (green or handed to a human).
 *
 * The decision is deterministic (ci-fix-loop); authoring + committing is the
 * driver (ci-fix-driver). Capability + secure_agent entitlement gated.
 * Returns: 200 { decision, ci, fix?, terminal?, brief? } | 400 | 401/403
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { requireEntitlement } from "@/lib/tenancy/require-entitlement";
import { fetchCiStatus, fetchCiAttribution } from "@/lib/ai-code/ci-status";
import { decideFixAction, buildFixBrief, fixAuthorTier } from "@/lib/ai-code/ci-fix-loop";
import { runCiFixStep } from "@/lib/ai-code/ci-fix-driver";
import { workspaceGithubClient, getBranchHead, countBranchCommitsMatching, listChangedFiles, listWorkflowRunsRaw, rerunFailedRun, triggerWorkflow } from "@/lib/github-client";
import { gatherFailureContext, buildEnrichedFixPrompt, extractFailingTestFiles, fetchFilesContent, hasFixAnchor, guardAuthoredFix } from "@/lib/ai-code/ci-failure-detail";
import { classifyCiFailure, failuresAreInfraOnly, isDependencyAuditFailure } from "@/lib/ai-code/ci-failure-classify";
import { flakeRecheckCandidates } from "@/lib/ai-code/flake";
import { commitFileChanges, filesToDiff } from "@/lib/ai-code/file-changes";
import { assessChange } from "@/lib/ai-code/assess";
import { authorFileChanges } from "@/lib/ai-code/author";
import { getAIClient } from "@/lib/ai";
import { trackEvent } from "@/lib/analytics";

const MAX_ATTEMPTS_CEILING = 5;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const gate = await requireEntitlement(auth.user.workspaceId, "secure_agent");
  if (gate) return gate;

  let b: { repo?: unknown; ref?: unknown; branch?: unknown; base?: unknown; attempt?: unknown; maxAttempts?: unknown };
  try {
    b = (await req.json()) as typeof b;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const repo = typeof b.repo === "string" ? b.repo.trim() : "";
  const ref = typeof b.ref === "string" ? b.ref.trim() : "";
  const branch = typeof b.branch === "string" ? b.branch.trim() : "";
  const base = typeof b.base === "string" ? b.base.trim() : "";
  if (!repo || !ref) return NextResponse.json({ error: "repo and ref are required" }, { status: 400 });
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) {
    return NextResponse.json({ error: "repo must be in owner/name form" }, { status: 400 });
  }

  const workspaceId = auth.user.workspaceId ?? undefined;
  const attempt = typeof b.attempt === "number" && Number.isFinite(b.attempt) ? Math.max(0, Math.floor(b.attempt)) : 0;
  const maxAttempts =
    typeof b.maxAttempts === "number" && Number.isFinite(b.maxAttempts)
      ? Math.max(1, Math.min(MAX_ATTEMPTS_CEILING, Math.floor(b.maxAttempts)))
      : 3;

  // Read CI for the PR HEAD (the branch), where the checks actually ran - NOT the
  // task-id `ref`, which is not a git ref and would 404. Fall back to ref only
  // when no branch is given (a decide-only caller must pass a real ref then).
  const ciRef = branch || ref;
  const ci = await fetchCiStatus(repo, ciRef, workspaceId);

  // Baseline attribution: when a base branch is named, only the failures this
  // change INTRODUCED are the fixer's to repair. Pre-existing red is not touched
  // (the fixer did not break it), and the fix brief targets only introduced
  // checks. Without a base, the fixer stays baseline-unaware (fixes any red).
  const attribution = base ? await fetchCiAttribution(repo, base, ciRef, workspaceId) : null;
  const introducedFailing = attribution ? attribution.introduced.length : undefined;
  const briefDetails = attribution
    ? ci.failedDetails.filter((d) => attribution.introduced.includes(d.name))
    : ci.failedDetails;

  // Decide-only when there is no branch to commit a fix to.
  if (!branch) {
    const decision = decideFixAction({ ci, attempt, maxAttempts, introducedFailing });
    const brief = decision.action === "author_fix" ? buildFixBrief(briefDetails) : undefined;
    return NextResponse.json({ decision, ci, ...(attribution ? { attribution } : {}), ...(brief ? { brief } : {}) });
  }

  // Drive it: author the fix and commit to the PR branch.
  const ai = getAIClient();
  const client = await workspaceGithubClient(workspaceId ?? "default");
  // Tamper-proof auto-fix budget: the branch's OWN count of prior "factory
  // ci-fix:" commits is a floor on attempts already made. A caller (or an
  // autonomous trigger) that passes attempt=0 cannot loop past the ceiling,
  // because the real history, not the request, sets the effective attempt.
  const priorFixCommits = client.token
    ? await countBranchCommitsMatching(client, repo, base || "main", branch, "factory ci-fix:")
    : 0;
  const effectiveAttempt = Math.max(attempt, priorFixCommits);
  if (!client.token) {
    // Cannot commit without a token; fall back to a decision the caller can act on.
    const decision = decideFixAction({ ci, attempt: effectiveAttempt, maxAttempts, introducedFailing });
    return NextResponse.json({ decision, ci, terminal: decision.action !== "author_fix", note: "no GitHub token; decision only" });
  }

  // The failing detail powers BOTH the re-author prompt and the non-progress
  // diagnosis. Gather it ONCE, and only when the deterministic decision would
  // actually be to author a fix (green / pending / pre-existing-only never reach
  // here), so we never pay for a log fetch we will not use.
  let contextSummary: { detailChars: number; files: string[] } | null = null;
  let gathered: Awaited<ReturnType<typeof gatherFailureContext>> | null = null;
  // The files this change actually consists of (its diff vs base). The
  // authoritative anchor for the re-author: fix THESE files, never invent a new
  // path. Computed once when there is an introduced failure to act on.
  let changedFiles: string[] = [];
  let stalledOnAuthoredTest: { testFiles: string[] } | undefined;
  let unresolvedContradiction: { testFiles: string[] } | undefined;
  let governanceFailure: { signal: string } | undefined;
  let transientFailure: { signal: string } | undefined;
  let flakeRecheckTriggered = false;
  let deterministicFixDispatched = false;
  let snapshotFailure = false;
  let unfixableNoDetail: { checks: readonly string[] } | undefined;
  let mechanicalSubtype: string | undefined;
  // Gather whenever there is an INTRODUCED failure to act on - i.e. CI is
  // readable, complete, not green, and this change introduced at least one of the
  // failures. That covers BOTH the author-a-fix case and the budget-exhausted
  // case, so the wrong-test diagnosis is produced even after the fix budget is
  // spent (found by dogfooding: an already-stalled branch was otherwise escalated
  // with the generic "after N attempts" reason instead of the useful one).
  const introducedRed =
    ci.readable !== false &&
    ci.complete === true &&
    ci.ciComplete !== true &&
    (ci.failedChecks?.length ?? 0) > 0 &&
    (introducedFailing === undefined || introducedFailing > 0);
  if (introducedRed) {
    const headSha = await getBranchHead(client, repo, branch).catch(() => branch);
    // Scope to the INTRODUCED failures (when a baseline is known) so the fixer
    // never tries to repair pre-existing red it did not cause.
    gathered = await gatherFailureContext(client, repo, headSha, branch, { onlyRunNames: attribution?.introduced });
    // The change's own files, always - the fixer's authoritative anchor. Even
    // when the log is unavailable (blob expired, no matching error lines), the
    // fixer must edit the files THIS change contains, never hallucinate a new
    // path (dogfooding: it authored src/lib/utils/deepMerge.js instead of the
    // real src/lib/deepMerge.ts because it had zero anchor).
    changedFiles = await listChangedFiles(client, repo, base || "main", branch);
    // When the failure log yielded no file contents, fall back to the changed
    // files themselves so the re-author still sees the real code to edit.
    if (gathered.files.length === 0 && changedFiles.length > 0) {
      const anchor = await fetchFilesContent(client, repo, changedFiles, branch);
      if (anchor.length > 0) gathered = { detail: gathered.detail, files: anchor };
    }
    contextSummary = { detailChars: gathered.detail.length, files: gathered.files.map((f) => f.path) };
    // Governance/policy gate? A guardrail / security-scan / RLS / coverage failure
    // is a human policy decision, not a mechanical fix - do not let the fixer edit
    // code to make a governance gate pass. Classify from the check names + detail.
    const cls = classifyCiFailure(gathered.detail, ci.failedChecks);
    if (cls.kind === "governance") {
      // A dependency-audit advisory is a governance gate we must never let a model
      // hack - but a patched version usually EXISTS, and that fix is deterministic
      // (a targeted `npm audit fix --package-lock-only`). Dispatch a no-model
      // dep-fixer workflow (same pattern as lint) instead of spending a human; only
      // escalate when no fix workflow is configured or the dispatch fails. This
      // removes the manual remediation step (a human ran the bump by hand this
      // session). Opt-in via env, and first-attempt only (mirrors the lint fixer).
      const depFixWorkflow = process.env.DEP_FIX_WORKFLOW;
      if (isDependencyAuditFailure(ci.failedChecks) && depFixWorkflow && priorFixCommits === 0) {
        const ok = await triggerWorkflow(client, repo, depFixWorkflow, branch).then(() => true).catch(() => false);
        if (ok) deterministicFixDispatched = true;
        else governanceFailure = { signal: cls.signal };
      } else {
        governanceFailure = { signal: cls.signal };
      }
    } else if (cls.kind === "transient") {
      transientFailure = { signal: cls.signal };
    } else {
      // Mechanical: record the subtype (routes the fix prompt), and either escalate
      // a snapshot (never auto-update - masks a regression) or, on the FIRST
      // attempt, re-run once to rule out a flake before authoring.
      mechanicalSubtype = cls.subtype;
      const detWorkflow = process.env.DETERMINISTIC_FIX_WORKFLOW;
      if (cls.subtype === "snapshot") {
        snapshotFailure = true;
      } else if (cls.subtype === "lint" && detWorkflow && priorFixCommits === 0) {
        // Deterministic lint/format fix (eslint --fix / prettier) via a GitHub
        // Action - runs in GitHub's isolation, no model, cheaper + safer. Dispatch
        // it and wait for it to commit + re-run CI. Opt-in via env; without the
        // workflow configured, lint falls through to the model path below.
        const ok = await triggerWorkflow(client, repo, detWorkflow, branch).then(() => true).catch(() => false);
        if (ok) deterministicFixDispatched = true;
      }
      if (!snapshotFailure && !deterministicFixDispatched && priorFixCommits === 0) {
        const runs = await listWorkflowRunsRaw(client, repo, headSha).catch(() => []);
        const candidates = flakeRecheckCandidates(runs, attribution?.introduced);
        if (candidates.length > 0) {
          await Promise.all(candidates.map((id) => rerunFailedRun(client, repo, id)));
          flakeRecheckTriggered = true;
        }
      }
      // No readable code-level error to act on, and we are not waiting on a flake
      // re-run: escalate ONLY when every failing check we are responsible for is a
      // deploy / setup / infra check (a preflight gate, a Vercel deploy, an e2e
      // harness that never starts) - those fail before any code runs, so a source
      // fix cannot repair them. A code check (unit / lint / type / build) with
      // empty detail is NOT infra - it is a real code failure whose log our
      // extractor simply did not parse, so the fixer should still try (anchored to
      // the change's files). Dogfooding apex surfaced this: a `unit (3/4)` /
      // `lint-types` failure with empty detail must not be mis-escalated as infra.
      const responsibleFailing =
        attribution && attribution.introduced.length > 0
          ? (ci.failedChecks ?? []).filter((c) => attribution.introduced.includes(c))
          : (ci.failedChecks ?? []);
      if (
        !snapshotFailure &&
        !deterministicFixDispatched &&
        !flakeRecheckTriggered &&
        gathered.detail.trim() === "" &&
        failuresAreInfraOnly(responsibleFailing)
      ) {
        unfixableNoDetail = { checks: responsibleFailing };
      }
    }
    // Non-progress on an authored test: if a fix was ALREADY committed and a test
    // THIS change added/changed is still failing, the test's expected value is the
    // likely culprit. We do NOT escalate - we tell the re-author to correct the
    // wrong test expectation so the loop CONVERGES to green (a human still reviews
    // + merges). Found by dogfooding the averageWordLength / parseDuration cases.
    if (priorFixCommits >= 1) {
      const failingTests = extractFailingTestFiles(gathered.detail);
      if (failingTests.length > 0) {
        const changed = new Set(changedFiles);
        const authoredFailing = failingTests.filter((f) => changed.has(f));
        if (authoredFailing.length > 0) {
          // First stall: tell the re-author to correct the wrong test expectation
          // (converges the averageWordLength / parseDuration cases). But if the
          // authored test is STILL failing on a SECOND+ attempt, that guidance did
          // not converge - source and test disagree from an ambiguous spec and the
          // fixer is oscillating. Escalate with the specific tests rather than
          // burn the rest of the budget silently (scored-matrix finding:
          // parseRange). priorFixCommits >= 2 means >= 1 prior "fix the test" pass.
          if (priorFixCommits >= 2) unresolvedContradiction = { testFiles: authoredFailing };
          else stalledOnAuthoredTest = { testFiles: authoredFailing };
        }
      }
    }
  }

  const result = await runCiFixStep({
    ci,
    attempt: effectiveAttempt,
    maxAttempts,
    introducedFailing,
    governanceFailure,
    transientFailure,
    flakeRecheckTriggered,
    deterministicFixDispatched,
    snapshotFailure,
    unfixableNoDetail,
    unresolvedContradiction,
    briefDetails,
    reauthor: async (brief) => {
      // Reuse the context gathered above (never re-fetch). Empty only if the
      // decision changed under us; buildEnrichedFixPrompt degrades to the brief.
      const context = gathered ?? { detail: "", files: [] };
      // Fail-closed: with NO anchor at all - no failure detail, no file contents,
      // and no known changed files - the model would author blind and hallucinate
      // a wrong-path file (dogfooding: src/lib/utils/deepMerge.js). Refuse; the
      // driver escalates to a human instead of committing a guess.
      if (!hasFixAnchor(context, changedFiles)) {
        return { changes: [], author: "", error: "no failure context or changed-file anchor; refusing to author blind" };
      }
      const prompt = buildEnrichedFixPrompt({ repo, branch, brief, context, authoredTestStillFailing: stalledOnAuthoredTest?.testFiles, subtype: mechanicalSubtype, changedFiles });
      // Escalate the model tier once the cheap attempt has failed: a stronger model
      // gets a shot BEFORE the loop escalates to a human (dogfooding: the cheap
      // model oscillated on a trivial uniform fix; a capability gap, not a spec one).
      const authored = await authorFileChanges(
        { prompt, feature: "ai-code-ci-fix", tier: fixAuthorTier(effectiveAttempt) },
        { complete: (r) => ai.complete(r) },
      );
      // Anti-hallucination guard (pure, tested): reject a fix that edits none of
      // this change's files and only invents new paths.
      const guarded = guardAuthoredFix({ changes: authored.changes, authorError: authored.error, changedFiles });
      return { changes: guarded.changes, author: authored.author, error: guarded.error };
    },
    // The autonomous fix clears the SAME combined gate as the front door before it
    // is committed. A fix carrying a secret / injection / critical finding is never
    // pushed to the PR branch; the step escalates to a human.
    gate: async (changes) => {
      const a = await assessChange(filesToDiff(changes));
      return { cleared: a.handoffAllowed, blockedBy: a.blockedBy };
    },
    commit: (changes) =>
      commitFileChanges({ client, repoFullName: repo, branch, base: branch, changes, message: `factory ci-fix: ${ref}` }),
  });

  // Record every TERMINAL outcome so the factory surfaces its own gaps: merge_ready
  // is an autonomous win; escalate_human with its reason/class is a spot a human is
  // STILL needed. Aggregating the escalations IS the automation backlog - the thing
  // dogfooding is meant to reveal. Non-terminal (wait/author_fix) is in-flight, not
  // an outcome, so it is not recorded here.
  if (result.terminal) {
    const cls = governanceFailure
      ? "governance"
      : unresolvedContradiction
        ? "ambiguous_spec"
        : unfixableNoDetail
          ? "infra_no_detail"
          : introducedFailing === 0
            ? "preexisting_only"
            : mechanicalSubtype ?? "other";
    trackEvent("ai_code.ci_fix_resolved", auth.user.id, auth.user.role, {
      repo,
      ref,
      action: result.decision.action,
      reason: result.decision.reason,
      attempts: effectiveAttempt,
      introduced_failing: introducedFailing ?? "baseline_unaware",
      class: cls,
      deterministic_fix: deterministicFixDispatched,
    });
  }
  return NextResponse.json({ ...result, context: contextSummary, budget: { attempt: effectiveAttempt, priorFixCommits, maxAttempts }, ...(stalledOnAuthoredTest ? { stalledOnAuthoredTest } : {}), ...(unresolvedContradiction ? { unresolvedContradiction } : {}), ...(governanceFailure ? { governanceFailure } : {}), ...(transientFailure ? { transientFailure } : {}), ...(flakeRecheckTriggered ? { flakeRecheckTriggered: true } : {}), ...(snapshotFailure ? { snapshotFailure: true } : {}), ...(deterministicFixDispatched ? { deterministicFixDispatched: true } : {}), ...(unfixableNoDetail ? { unfixableNoDetail } : {}), ...(mechanicalSubtype ? { subtype: mechanicalSubtype } : {}) });
}
