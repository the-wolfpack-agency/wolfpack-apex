/**
 * /api/admin/ai-code/pipeline — one governed run over an AI-authored change.
 *
 *   POST { ref, prompt, answers?, diff?, author?, authorModel?, executorProviderPin?, maxAttempts? }
 *        -> EXECUTOR (no diff supplied -> a model authors it from the prompt;
 *           input-to-output) -> intake (fixed multiple-choice -> frozen spec) ->
 *           the deterministic gate -> Stage 2 re-route repair on a non-allow
 *           verdict (a DIFFERENT lineage than the executor). Returns a run
 *           that is READY FOR PR only when the gate allowed the final diff (the
 *           original or a repaired one it re-checked), otherwise needs_human.
 *           This route never merges: a human opens the PR.
 *
 * Capability: settings.manage_team. Hash-chain AUDITED and emits
 * ai_code.pipeline_run for the learning loop. An off-menu intake answer is a 400
 * (the answer space is fixed), not a 500.
 *
 * Returns: 200 { run } | 400 (bad body / off-menu answer) | 401/403 (auth)
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { factoryServiceAuth } from "@/lib/ai-code/factory-service-auth";
import { requireEntitlement } from "@/lib/tenancy/require-entitlement";
import { trackEvent, trackEventAwait } from "@/lib/analytics";
import { recordAudit } from "@/lib/audit-log";
import { runCodeReview } from "@/lib/ai-code/scan";
import { liveRepairComplete } from "@/lib/ai-code/repair";
import { runPipeline } from "@/lib/ai-code/pipeline";
import { authorDiff, authorFileChanges, authorAnchorEdits } from "@/lib/ai-code/author";
import { filesToDiff, type FileChange } from "@/lib/ai-code/file-changes";
import { applyAnchorEdits, anchorFailureFeedback, type AnchorFailure } from "@/lib/ai-code/anchor-edit";
import { newFilesFromDiff } from "@/lib/ai-code/oracle";
import { checkSyntax } from "@/lib/ai-code/syntax-check";
import { remediateFileChanges } from "@/lib/ai-code/repair-files";
import { buildRegistry, judgeCandidates, escalationProviderPins } from "@/lib/ai/router";
import { chooseIndependentJudge } from "@/lib/ai/judge-selection";
import { evaluateChangeInvariants } from "@/lib/ai-code/change-facts";
import { deepScanChange } from "@/lib/ai-code/deep-scan";
import { buildRunCost } from "@/lib/ai-code/cost";
import { workspaceGithubClient, fetchFileContent, fetchRepoTree } from "@/lib/github-client";
import { buildRepoContext, withRepoContext, extractMentionedPaths } from "@/lib/ai-code/repo-context";
import { findReuseCandidates } from "@/lib/ai-code/reuse-scout";
import { buildKnownExportsBlock, exportsEntries } from "@/lib/ai-code/export-grounding";
import { duplicationSignal, duplicationGate } from "@/lib/ai-code/reuse-enforcement";
import { pickAuthorMode } from "@/lib/ai-code/author-mode";
import { fetchRepoGrounding } from "@/lib/ai-code/repo-grounding";
import { findPhantomImports, parseInstalledRoots, phantomImportFeedback } from "@/lib/ai-code/imports";
import {
  findBrokenLocalImports,
  brokenLocalImportFeedback,
  extractLocalImports,
  resolveLocalCandidates,
  parseAliasMap,
  type ModuleResolver,
  type BrokenLocalImport,
} from "@/lib/ai-code/imports";
import { findIncompleteFiles, completenessFeedback } from "@/lib/ai-code/completeness";
import { findRemovedExports, type RemovedExport } from "@/lib/ai-code/exports-preservation";
import { getAIClient } from "@/lib/ai";
import type { AIModelTier } from "@/lib/ai/types";
import { DEFAULT_SPEC_QUESTIONS, resolveIntake, specDirectives, withSpecDirectives } from "@/lib/ai-code/intake";
import { createPendingApproval } from "@/lib/agents/approvals/store";
import { ensureCodeGateAgent } from "@/lib/agents/store";
import type { CodeReviewResult } from "@/lib/ai-code/types";

const MAX_DIFF = 2_000_000; // chars
/** The repo a run targets for GROUNDING + import validation when none is supplied.
 *  Self-hosted runs (repo omitted) are how the factory maintains ITS OWN code, so
 *  they must get the same grounding + local-import gate as an external repo - not
 *  silently skip them. Mirrors the executor's PR-commit default. */
const SELF_REPO = process.env.FACTORY_TARGET_REPO || "the-wolfpack-agency/wolfpack-apex";
/** How much of the diff to persist on the run event so the history UI can show
 *  the actual code change. Capped so a huge diff never bloats the event row; the
 *  full diff still lives on the run response + (for ready runs) the approval. */
const HISTORY_DIFF_CAP = 120_000;
const MAX_ATTEMPTS_CAP = 4;
/** The fixed answer-key allowlist. The route always runs the default questions,
 *  so a valid answer names one of these; anything else is dropped, never used as
 *  a property name to write. */
const SPEC_QUESTION_IDS = new Set(DEFAULT_SPEC_QUESTIONS.map((q) => q.id));

/** Common executor evidence (both authoring modes carry these). */
type ExecutorEvidence = { author: string; provider: string | null; costUsd: number | null; latencyMs: number | null; inputTokens: number | null; outputTokens: number | null; error: string | null };

/** The new/changed files a resolved change carries: full-file changes when
 *  present, else the new files reconstructed from the diff. Used for the syntax
 *  gate and the retry-on-unparseable check. */
function resolvedFiles(r: { diff: string; changes: FileChange[] | null }): { path: string; content: string }[] {
  if (r.changes && r.changes.length > 0) return r.changes;
  return Object.entries(newFilesFromDiff(r.diff)).map(([path, content]) => ({ path, content }));
}

/**
 * Resolve the change the pipeline will govern. Three sources, all feeding the
 * SAME gate (authoring is a feature, not a security check):
 *  - supplied diff (governed as-is)
 *  - files mode: the executor authors FULL FILE CONTENTS (edit-support); the
 *    review substrate is a synthesized diff, and `changes` carries the files for
 *    the commit
 *  - diff mode (default): the executor authors a unified diff (new files)
 */
async function resolveChange(args: {
  mode: "diff" | "files" | "anchor";
  diff: string;
  prompt: string;
  authorModel: string;
  executorProviderPin?: string;
  tier?: AIModelTier;
  /** For anchor mode: fetch the live content of the files being edited (apply needs it). */
  fetchFiles?: (paths: string[]) => Promise<Record<string, string>>;
}): Promise<{ diff: string; author: string; executor: ExecutorEvidence | null; changes: FileChange[] | null; anchorFailures?: AnchorFailure[] }> {
  if (args.mode === "anchor") {
    // Large-file edit mode: author emits exact SEARCH/REPLACE blocks, we fetch the
    // live files and apply deterministically (a wrong anchor escalates, never a bad
    // edit). The applied result is full-file content -> same gate + CI path.
    const client = getAIClient();
    const authored = await authorAnchorEdits(
      { prompt: args.prompt, executorProviderPin: args.executorProviderPin, feature: "ai-code-pipeline-author-anchor", tier: args.tier },
      { complete: (r) => client.complete(r) },
    );
    const paths = Array.from(new Set(authored.edits.map((e) => e.path)));
    const files = args.fetchFiles ? await args.fetchFiles(paths) : {};
    const applied = applyAnchorEdits(files, authored.edits);
    const newOnly = authored.newFiles.filter((nf) => !applied.changes.some((c) => c.path === nf.path));
    const changes = [...applied.changes, ...newOnly];
    const ev: ExecutorEvidence = { author: authored.author, provider: authored.provider, costUsd: authored.costUsd, latencyMs: authored.latencyMs, inputTokens: authored.inputTokens ?? null, outputTokens: authored.outputTokens ?? null, error: authored.error };
    return { diff: filesToDiff(changes), author: authored.author, executor: ev, changes, anchorFailures: applied.failures };
  }
  if (args.mode === "files") {
    const client = getAIClient();
    const authored = await authorFileChanges(
      { prompt: args.prompt, executorProviderPin: args.executorProviderPin, feature: "ai-code-pipeline-author-files", tier: args.tier },
      { complete: (r) => client.complete(r) },
    );
    const ev: ExecutorEvidence = { author: authored.author, provider: authored.provider, costUsd: authored.costUsd, latencyMs: authored.latencyMs, inputTokens: authored.inputTokens ?? null, outputTokens: authored.outputTokens ?? null, error: authored.error };
    return { diff: filesToDiff(authored.changes), author: authored.author, executor: ev, changes: authored.changes };
  }
  if (args.diff.trim()) return { diff: args.diff, author: args.authorModel, executor: null, changes: null };
  const client = getAIClient();
  const executor = await authorDiff(
    { prompt: args.prompt, executorProviderPin: args.executorProviderPin, feature: "ai-code-pipeline-author", tier: args.tier },
    { complete: (r) => client.complete(r) },
  );
  const ev: ExecutorEvidence = { author: executor.author, provider: executor.provider, costUsd: executor.costUsd, latencyMs: executor.latencyMs, inputTokens: executor.inputTokens ?? null, outputTokens: executor.outputTokens ?? null, error: executor.error };
  return { diff: executor.diff, author: executor.author, executor: ev, changes: null };
}

type ResolveArgs = Parameters<typeof resolveChange>[0];

/** Context a local-import check needs: the repo tree (authoritative for module
 *  existence) + tsconfig path aliases. */
type LocalImportCtx = { repo: string | null; workspaceId: string; repoTree: Set<string>; aliasMap: Record<string, string> };

/**
 * Resolve + name-check every LOCAL import in `files` against the repo tree and
 * the (fetched) source of each target module. Shared by the author-retry (so a
 * hallucinated local import SELF-CORRECTS) and the final gate (so it blocks if
 * the retry still did not fix it). Fail-open: unknown tree or a fetch failure
 * returns []. The retry and the gate therefore apply the exact same rule.
 */
async function checkLocalImports(
  files: readonly { path: string; content: string }[],
  ctx: LocalImportCtx,
): Promise<BrokenLocalImport[]> {
  if (!ctx.repo || ctx.repoTree.size === 0) return [];
  try {
    const changeset = new Map(files.map((f) => [f.path, f.content]));
    const repoCache = new Map<string, string | null>();
    const wanted = new Set<string>();
    for (const f of files) {
      for (const li of extractLocalImports(f.path, f.content)) {
        const cands = resolveLocalCandidates(f.path, li.spec, ctx.aliasMap);
        if (cands.some((c) => changeset.has(c))) continue; // authored in THIS change
        for (const c of cands) if (ctx.repoTree.has(c)) { wanted.add(c); break; }
      }
    }
    if (wanted.size > 0) {
      const gh = await workspaceGithubClient(ctx.workspaceId);
      for (const path of wanted) {
        const c = await fetchFileContent(gh, ctx.repo, path).catch(() => null);
        repoCache.set(path, typeof c === "string" ? c : null);
      }
    }
    const resolver: ModuleResolver = (fromPath, spec) => {
      for (const cand of resolveLocalCandidates(fromPath, spec, ctx.aliasMap)) {
        if (changeset.has(cand)) return { exists: true, content: changeset.get(cand) ?? null };
        if (ctx.repoTree.has(cand)) return { exists: true, content: repoCache.get(cand) ?? null };
      }
      return { exists: false, content: null };
    };
    return findBrokenLocalImports(files, resolver);
  } catch {
    return []; // best-effort: never block a handoff on a resolver/fetch failure
  }
}

/**
 * Author with a GOVERNED fallback so a simple authoring failure does not end the
 * run. If the first executor produces nothing usable (and no manual diff was
 * supplied), retry once at an escalated tier - a stronger model gets a usable
 * draft to the SAME gate. Only after the fallback still produces nothing does the
 * run surface a 422. The agent keeps the workflow running; the gate still governs
 * whatever it drafts, so this never weakens a check, it only avoids a dead end.
 */
async function resolveChangeWithFallback(
  args: ResolveArgs,
  installedRoots: ReadonlySet<string> = new Set(),
  /** Optional async check for hallucinated LOCAL imports. When it finds any, the
   *  draft self-corrects (escalate + exact feedback) instead of only blocking at
   *  the gate - the #229 class (a name a real module doesn't export). */
  localImportCheck?: (files: readonly { path: string; content: string }[]) => Promise<BrokenLocalImport[]>,
): Promise<Awaited<ReturnType<typeof resolveChange>> & { executorAttempts: number; effectiveMode: "diff" | "files" | "anchor" }> {
  const emptyOrError = (r: Awaited<ReturnType<typeof resolveChange>>) => !r.diff.trim() || Boolean(r.executor?.error);
  // Deterministic reasons a draft is bad, each fed back to the escalation retry:
  //  - empty / errored output
  //  - does not PARSE (diff-mode truncation drops a closing brace)
  //  - imports a PHANTOM dependency (a package not in package.json) - it compiles
  //    in the model's head but always fails CI ("Cannot find module"); the apex
  //    dogfooding `nookies` hallucination. Grounding only ADVISES against this;
  //    here it is enforced and self-corrected.
  const draftFeedback = (r: Awaited<ReturnType<typeof resolveChange>>): string | null => {
    if (emptyOrError(r)) return "The previous attempt produced no usable output (empty or errored). Return the COMPLETE file(s) that satisfy the request.";
    const files = resolvedFiles(r);
    // A non-empty diff that yields NO committable full-file changes is a
    // modification-only diff (it edits existing lines rather than creating files).
    // Our commit path commits full files, not patches, so such a draft is
    // ready-looking but UNCOMMITTABLE ("no file changes to commit"). Recover in
    // files mode, where the model returns the COMPLETE edited file. Found by
    // dogfooding the edit-existing class: the factory could create new files but
    // never EDIT one, because a modification diff has no full files to commit.
    if (files.length === 0 && r.diff.trim()) {
      return "The previous attempt was a modification-only diff, which cannot be committed (the commit path writes full files, not patches). Return the COMPLETE contents of every file you change - including your edits merged into the existing code - not a diff.";
    }
    const issues = checkSyntax(files).issues;
    if (issues.length > 0) return `The previous attempt did NOT parse. Fix these exact syntax errors and return the COMPLETE, valid file(s):\n${issues.map((i) => `- ${i.path}:${i.line} ${i.message}`).join("\n")}`;
    const phantoms = findPhantomImports(files, installedRoots);
    if (phantoms.length > 0) return phantomImportFeedback(phantoms);
    const incomplete = findIncompleteFiles(files);
    if (incomplete.length > 0) return completenessFeedback(incomplete);
    return null;
  };
  let resolved = await resolveChange(args);
  let attempts = 1;
  let effectiveMode = args.mode;
  const manualDiff = args.diff.trim().length > 0;

  // ANCHOR MODEL-ESCALATION (the tool's core cheap-first-then-route-to-a-model-that-
  // -can-do-it design): a failed anchor edit means the current model could not locate
  // the exact spans in a (often large) file. A TIER bump does not help here - in a
  // single-deployment Azure environment every tier resolves to the same cheap model -
  // so we escalate by PINNING a DIFFERENT available model (strongest first; the
  // Foundry models are genuinely distinct and reachable by pin), re-authoring the SAME
  // anchor task with the exact failure fed back, until the anchors apply cleanly or the
  // available models are exhausted. Only then is it a genuine needs_human. It STAYS in
  // anchor mode (never a lossy whole-file rewrite). This is why a client's complex task
  // is not answered with "we only ran a cheap model": it routes to one that can.
  if (args.mode === "anchor" && !manualDiff) {
    const candidates = escalationProviderPins({ excludePins: [args.executorProviderPin ?? ""] });
    for (const { pin, tier } of candidates) {
      if ((resolved.anchorFailures?.length ?? 0) === 0) break; // applied cleanly
      if (attempts >= MAX_ATTEMPTS_CAP) break; // bounded cost
      // Pin the provider complete() recognizes AND ask at the tier it serves, or the
      // pin is rejected by supportsTier and silently falls back to the cheap default.
      resolved = await resolveChange({
        ...args,
        executorProviderPin: pin,
        tier,
        prompt: `${args.prompt}\n\n${anchorFailureFeedback(resolved.anchorFailures ?? [])}`,
      });
      attempts++;
    }
    return { ...resolved, executorAttempts: attempts, effectiveMode: "anchor" };
  }

  const selfHealable = !manualDiff; // anchor is handled above; diff/files self-heal below
  let feedback = selfHealable ? draftFeedback(resolved) : null;
  // Then the async check: a hallucinated LOCAL import (resolves to no file, or a
  // name a real module does not export - the #229 class). Same self-heal path:
  // give the model the exact failure and re-author, instead of only blocking.
  if (!feedback && selfHealable && localImportCheck) {
    const broken = await localImportCheck(resolvedFiles(resolved));
    if (broken.length > 0) feedback = brokenLocalImportFeedback(broken);
  }
  if (feedback) {
    // Recover on a DIFFERENT, stronger MODEL, WITH the deterministic reason fed
    // back, AND in FILES mode. Three dogfooding lessons combined:
    //   (1) "give the model the real error" turns a needs_human hold into a
    //       converged draft;
    //   (2) files authoring (full contents) has no diff-reconstruction ambiguity,
    //       the #1 cause of a bad draft;
    //   (3) a TIER bump ("premium") was a NO-OP in a single-Azure-deployment env -
    //       it resolved to the SAME cheap model, so "escalation" re-ran the model
    //       that just failed (caught live: passes=2 but still gpt-4o-mini). So we
    //       escalate the SAME way the anchor path does: PIN a genuinely-distinct
    //       provider the router can actually invoke, at a tier it serves. Only when
    //       no distinct provider is configured do we fall back to the premium tier
    //       bump as a best effort (honest: nothing stronger exists to route to).
    const [candidate] = escalationProviderPins({ excludePins: [args.executorProviderPin ?? ""] });
    const retry = await resolveChange({
      ...args,
      mode: "files",
      ...(candidate ? { executorProviderPin: candidate.pin, tier: candidate.tier } : { tier: "premium" }),
      prompt: `${args.prompt}\n\n${feedback}`,
    });
    attempts++;
    resolved = retry; // the escalated attempt is the final draft (its evidence is what a human sees if it too failed)
    effectiveMode = "files";
  }
  return { ...resolved, executorAttempts: attempts, effectiveMode };
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = factoryServiceAuth(req) ?? await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const gate = await requireEntitlement(auth.user.workspaceId, "secure_agent");
  if (gate) return gate;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const b = (body ?? {}) as {
    ref?: unknown;
    prompt?: unknown;
    answers?: unknown;
    diff?: unknown;
    author?: unknown;
    authorModel?: unknown;
    authorTier?: unknown;
    executorProviderPin?: unknown;
    repo?: unknown;
    mode?: unknown;
    maxAttempts?: unknown;
  };
  const ref = typeof b.ref === "string" ? b.ref.trim() : "";
  const prompt = typeof b.prompt === "string" ? b.prompt : "";
  const diff = typeof b.diff === "string" ? b.diff : "";
  if (!ref) return NextResponse.json({ error: "ref is required" }, { status: 400 });
  if (!prompt.trim()) return NextResponse.json({ error: "prompt is required" }, { status: 400 });
  // Optional target repo. Validate the owner/repo shape up front so a malformed
  // value is a clean 400, never a string interpolated into a GitHub API path.
  // Absent -> the executor defaults to apex (self-hosting).
  const repoRaw = typeof b.repo === "string" ? b.repo.trim() : "";
  if (repoRaw && !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repoRaw)) {
    return NextResponse.json({ error: "repo must be in owner/name form" }, { status: 400 });
  }
  const repo = repoRaw || undefined;
  // The repo used for GROUNDING + import validation. Falls back to the self-hosted
  // repo so a self-targeted run (the factory improving itself) is grounded and its
  // imports are validated, instead of authoring blind and passing a hallucination.
  const groundingRepo = repo ?? SELF_REPO;
  // diff is OPTIONAL: when absent, the EXECUTOR stage authors it from the prompt
  // (input-to-output). A manually supplied diff is still governed as before. The
  // size ceiling is enforced ONCE, unconditionally, on the final diff below - it
  // is never gated by a user-controlled branch.

  // Answers are a flat questionId -> optionId map. The property NAME is
  // allowlisted to the fixed question set - never write a user-named property
  // (remote property injection). The option VALUE is validated by resolveIntake,
  // which rejects an off-menu value as a 400.
  const answers: Record<string, string> = {};
  if (b.answers && typeof b.answers === "object") {
    for (const [k, v] of Object.entries(b.answers as Record<string, unknown>)) {
      if (SPEC_QUESTION_IDS.has(k) && typeof v === "string") answers[k] = v;
    }
  }

  const author = typeof b.author === "string" && b.author.trim() ? b.author.trim() : "unknown";
  const authorModel = typeof b.authorModel === "string" && b.authorModel.trim() ? b.authorModel.trim() : author;
  // Pin the authoring capability tier so the SAME task can be run at each tier and
  // the resulting model (e.g. Azure cheap=gpt-4o-mini vs standard=gpt-4o) compared.
  // Only the first attempt uses it; the escalation retry still goes one tier up.
  const authorTier: AIModelTier | undefined =
    b.authorTier === "cheap" || b.authorTier === "standard" || b.authorTier === "premium" ? b.authorTier : undefined;
  const maxAttempts =
    typeof b.maxAttempts === "number" && Number.isFinite(b.maxAttempts)
      ? Math.max(1, Math.min(MAX_ATTEMPTS_CAP, Math.floor(b.maxAttempts)))
      : 2;

  const workspaceId = auth.user.workspaceId ?? "default";

  // EXECUTOR stage. No diff supplied -> a model authors it from the prompt, and
  // the authoring model becomes the pipeline `author` so the repairer is a
  // different lineage. Fail-closed: no diff authored -> 422 with the executor
  // evidence, never a 500 and never a fabricated diff.
  const executorProviderPin =
    typeof b.executorProviderPin === "string" && b.executorProviderPin.trim() ? b.executorProviderPin.trim() : undefined;
  const mode: "diff" | "files" | "anchor" = b.mode === "files" ? "files" : b.mode === "anchor" ? "anchor" : "diff";

  // Repo-aware context: when a target repo is set, fetch the current contents of
  // the files the prompt NAMES and prepend them so the executor MODIFIES existing
  // code consistently instead of authoring blind. Best-effort: any failure falls
  // back to prompt-only authoring (no regression). Skipped when a diff is supplied
  // (that is governed as-is). Uses the `repo` already validated above.
  let authorPrompt = prompt;
  let repoContextFiles: string[] = [];
  let reuseCandidates = 0;
  // The reuse-scout candidates (path + score), kept for the SHADOW duplication
  // signal recorded on the run event (did the change reuse the top candidate?).
  let reuseCandidatesList: { path: string; score: number }[] = [];
  // The repo's installed packages (package.json), so a phantom-import (a package
  // not installed) can be DETERMINISTICALLY caught and self-corrected - grounding
  // only advises against it. Empty set => unknown deps => the phantom check is a
  // no-op (fail-open).
  let installedRoots = new Set<string>();
  // Repo file tree + tsconfig path aliases: the authority for whether a LOCAL
  // import (`@/…` / relative) resolves to a real file, and for checking a name
  // a real local module actually exports. The tree (one call) is authoritative
  // for existence; content fetches read exports. Empty tree => the local-import
  // gate is a no-op (fail-open), exactly like installedRoots for the phantom gate.
  let repoTree = new Set<string>();
  let aliasMap: Record<string, string> = {};
  if (groundingRepo && !diff.trim()) {
    try {
      const ghClient = await workspaceGithubClient(workspaceId);
      if (ghClient.token) {
        // Two layers of context: GROUNDING (the repo's real shape - framework,
        // existing modules, test convention, installed deps) so the author never
        // invents an import, plus the named-file context for edits. Both are
        // best-effort and prepend to the author prompt.
        // Third layer: REUSE SCOUT - the semantic/whole-repo retrieval buildRepoContext
        // (path-only) defers. For an intent-described task it surfaces existing files
        // that already do it, so the author reuses instead of re-implementing. Runs in
        // the same Promise.all (no added latency); excludes files the prompt already named.
        const [grounding, ctx, reuse, pkgJson, tree, tsconfig] = await Promise.all([
          fetchRepoGrounding(ghClient, groundingRepo),
          buildRepoContext({ client: ghClient, repo: groundingRepo, prompt }),
          findReuseCandidates({ client: ghClient, repo: groundingRepo, prompt, excludePaths: extractMentionedPaths(prompt) }),
          fetchFileContent(ghClient, groundingRepo, "package.json").catch(() => null),
          fetchRepoTree(ghClient, groundingRepo).catch(() => [] as string[]),
          fetchFileContent(ghClient, groundingRepo, "tsconfig.json").catch(() => null),
        ]);
        reuseCandidates = reuse.candidates.length;
        reuseCandidatesList = reuse.candidates.map((c) => ({ path: c.path, score: c.score }));
        repoTree = new Set(tree);
        if (tsconfig) aliasMap = parseAliasMap(tsconfig);

        // EXPORT GROUNDING: the exact exported symbols of the modules this task is
        // most likely to import from (the reuse candidates + the files the prompt
        // named), so the author imports a REAL name instead of inventing one - the
        // #229 class, made impossible for any model at the source. Best-effort,
        // capped, and only when we could read the alias map (so specifiers are right).
        let exportsBlock = "";
        if (Object.keys(aliasMap).length > 0) {
          const wantPaths = [
            ...reuse.candidates.map((c) => c.path),
            ...extractMentionedPaths(prompt),
          ].filter((p) => /\.(tsx?|jsx?|mjs|cjs)$/.test(p));
          const uniquePaths = [...new Set(wantPaths)].slice(0, 8);
          const fetched: { path: string; content: string }[] = [];
          for (const p of uniquePaths) {
            const c = await fetchFileContent(ghClient, groundingRepo, p).catch(() => null);
            if (typeof c === "string") fetched.push({ path: p, content: c });
          }
          exportsBlock = buildKnownExportsBlock(exportsEntries(fetched, aliasMap));
        }

        // REUSE block first (read existing capability), then the exact exports.
        const block = [grounding, reuse.block, exportsBlock, ctx.block].filter(Boolean).join("\n\n---\n\n");
        authorPrompt = withRepoContext(prompt, block);
        repoContextFiles = ctx.files;
        if (pkgJson) installedRoots = parseInstalledRoots(pkgJson);
      }
    } catch {
      /* best-effort context; author from the prompt alone on any failure */
    }
  }

  // Make the frozen spec GOVERN authoring, not just get recorded: prepend the
  // consistency directive + the resolved spec directives (error-handling,
  // input-strictness, ...) to the author prompt. This closes the root cause the
  // scored matrix found - authoring happened blind and a spec was recorded after,
  // so an ambiguous point was read two ways (source vs test). Only when authoring
  // from a prompt (a supplied diff is governed as-is).
  if (!diff.trim()) {
    const { answers: resolvedSpec } = resolveIntake(DEFAULT_SPEC_QUESTIONS, answers);
    authorPrompt = withSpecDirectives(authorPrompt, specDirectives(DEFAULT_SPEC_QUESTIONS, resolvedSpec));
  }

  // Anchor mode needs the live content of the files it edits, fetched on demand.
  const fetchFilesForAnchor = async (paths: string[]): Promise<Record<string, string>> => {
    // groundingRepo (not repo): a self-hosted edit must fetch the live file too,
    // or anchor apply fails with file_not_provided (the #1024 miss - the factory
    // could not edit its OWN files).
    if (!groundingRepo) return {};
    const out: Record<string, string> = {};
    try {
      const client = await workspaceGithubClient(workspaceId);
      for (const path of paths) {
        const c = await fetchFileContent(client, groundingRepo, path).catch(() => null);
        if (typeof c === "string") out[path] = c;
      }
    } catch { /* best-effort; a missing file becomes an anchor failure, which escalates */ }
    return out;
  };
  // Shared local-import context: the author-retry self-corrects a hallucinated
  // local import with it, and the final gate re-checks with the SAME logic.
  const localImportCtx: LocalImportCtx = { repo: groundingRepo, workspaceId, repoTree, aliasMap };
  // AUTO EDIT-MODE: files mode cannot edit an existing file - it rewrites whole
  // files with no live base, so an edit to a 300-line module produces an empty
  // change (422). When the task targets a file that ALREADY exists, author via
  // ANCHOR instead (fetches the live file + exact SEARCH/REPLACE). New-file tasks
  // stay in files mode; a user-pinned anchor/diff is respected. Found by
  // dogfooding: editing the factory's own imports.ts 422'd in files AND anchor
  // (the latter on the fetch bug above) - the factory could not edit existing code.
  const authorMode = pickAuthorMode(mode, extractMentionedPaths(prompt), repoTree);

  const resolved = await resolveChangeWithFallback(
    { mode: authorMode, diff, prompt: authorPrompt, authorModel, executorProviderPin, tier: authorTier, fetchFiles: fetchFilesForAnchor },
    installedRoots,
    (files) => checkLocalImports(files, localImportCtx),
  );
  // The mode the draft ACTUALLY ended on: a bad first draft recovers in files
  // mode, so downstream files-mode handling (repair loop, handoff, response) must
  // key on the effective mode, not the requested one.
  const effectiveMode = resolved.effectiveMode;
  const executorAttempts = resolved.executorAttempts;
  const executor = resolved.executor;
  let effectiveDiff = resolved.diff;
  let effectiveAuthor = resolved.author;
  let changes = resolved.changes;
  // Anchor edits that did not apply cleanly (missing/ambiguous anchor). A non-empty
  // list blocks handoff: an edit that did not fully apply is never auto-PR'd.
  const anchorFailures = resolved.anchorFailures ?? [];
  // Fail-closed: the executor ran but produced nothing usable. Never a 500, and
  // never a fabricated change - the gate has nothing to govern.
  if (executor && !effectiveDiff.trim()) {
    // Surface WHY, not just THAT: an unconfigured pinned provider (e.g. anthropic
    // on an Azure-only deployment) otherwise reads as an opaque "no change". The
    // real reason lives in executor.error; put it in the message the caller sees.
    return NextResponse.json(
      {
        error: executor?.error
          ? `executor produced no change (${executor.error})`
          : "executor produced no change",
        executor,
        anchorFailures,
      },
      { status: 422 },
    );
  }

  // Files-native AUTO-FIX: in files mode, if the authored files do not clear the
  // combined gate, re-author the whole files with the gate's feedback (routed to a
  // DIFFERENT lineage), bounded, until they pass or a human is needed. This is the
  // gate-level half of the auto-fix loop; the CI-level half runs post-PR.
  let filesRepairStatus: "clean" | "needs_human" | "n/a" = "n/a";
  if (effectiveMode === "files" && changes && changes.length > 0) {
    const client = getAIClient();
    const indep = chooseIndependentJudge(
      { provider: executor?.provider ?? "", model: effectiveAuthor },
      judgeCandidates(buildRegistry(), "cheap"),
    ).candidate?.provider;
    const repaired = await remediateFileChanges({
      initial: changes,
      initialAuthor: effectiveAuthor,
      reauthor: (feedback) =>
        authorFileChanges(
          { prompt: `${prompt}\n\nThe previous attempt was rejected. ${feedback}`, executorProviderPin: indep, feature: "ai-code-pipeline-repair-files" },
          { complete: (r) => client.complete(r) },
        ),
      maxAttempts: 2,
    });
    changes = repaired.changes;
    effectiveAuthor = repaired.author;
    effectiveDiff = filesToDiff(changes);
    filesRepairStatus = repaired.status;
  }

  // Unconditional ceiling on the final diff, whatever its source (supplied or
  // authored). Enforced on every path, so no user-controlled input decides
  // whether this check runs.
  if (effectiveDiff.length > MAX_DIFF) return NextResponse.json({ error: "diff too large" }, { status: 400 });

  const review = async (d: string): Promise<CodeReviewResult> =>
    runCodeReview({ workspaceId, ref, author: effectiveAuthor, diff: d, nowIso: new Date().toISOString() });

  let run;
  try {
    run = await runPipeline({
      ref,
      prompt,
      answers,
      diff: effectiveDiff,
      author: effectiveAuthor,
      nowIso: new Date().toISOString(),
      review,
      repair: liveRepairComplete(),
      maxAttempts,
    });
  } catch (err) {
    // The only expected throw is an off-menu intake answer (fixed answer space).
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }

  // Deterministic engineering invariants over the FINAL diff, decided by the
  // OGIAM registry (deploy-once, dependency-as-last-resort; CI-complete applies
  // at the merge point, not authoring, so it is not asserted here). This runs
  // alongside the security gate: a change is only handed off when BOTH the
  // security gate allows AND no invariant would block.
  // In files mode the dependency delta is not derivable from a synthesized full
  // file (it shows every dep as "added"), so skip that signal; it stays exact in
  // diff mode. All other invariants apply in both modes.
  const { decision: invariants, facts: changeFacts } = evaluateChangeInvariants(run.diff, { skipDependency: changes != null });

  // Full-power deep static scan: run the platform-scan detector engine (provider-
  // signature secrets, taint/SSRF/SQLi) on the authored files, not just the ai-code
  // subset. A critical finding withholds the handoff, same as an invariant block.
  const deepScan = await deepScanChange(run.diff, repo);

  await recordAudit({
    actor: { user_id: auth.user.id, role: auth.user.role },
    action: "ai_code.pipeline_run",
    resourceType: "ai_code_pipeline_run",
    resourceId: `${workspaceId}:${ref}`,
    afterState: {
      spec_hash: run.spec.hash,
      status: run.status,
      attempts: run.remediation.attempts.length,
      final_outcome: run.review.verdict.outcome,
      open_questions: run.openQuestions.length,
      conforms: run.conformance.conforms,
      author: effectiveAuthor,
      executed: Boolean(executor),
      invariant_rule: invariants.ruleId,
      invariant_outcome: invariants.intendedOutcome,
      dependency_delta: changeFacts.dependencyDelta,
      deep_scan_critical: deepScan.critical,
      deep_scan_high: deepScan.high,
    },
  });

  // Protection evidence: one finding_detected per issue the gate caught, so the
  // "protected you from production issues" panel can show what class of problem
  // was stopped (secrets, injection, unsafe patterns) before it reached a human.
  // Workspace-scoped and capped. This is the same event the /review route emits.
  for (const f of run.review.findings.slice(0, 25)) {
    trackEvent("ai_code.finding_detected", auth.user.id, auth.user.role, {
      workspace_id: workspaceId,
      class: f.klass,
      severity: f.severity,
      cwe: f.cwe ?? "none",
    });
  }

  // Fail-closed handoff. A ready-for-PR run captures a PENDING APPROVAL - it does
  // NOT open a PR. A human opens the PR by approving this, through the existing
  // agent-approvals surface. A needs_human run has nothing to hand off. Capturing
  // is best-effort (null without a database); the run is returned either way.
  // Files mode hands off when the files-native repair cleared the change (its final
  // files pass the gate). needs_human means the auto-fix could not clear it after
  // its bounded attempts. Diff mode is unaffected.
  const filesModeHandoffOk = effectiveMode !== "files" || filesRepairStatus === "clean";

  // Syntax gate: the change must PARSE. The security gate scans for secrets /
  // injection, not "does this compile", so a truncated/malformed draft could
  // otherwise be marked ready. Code that does not parse can never hand off - it
  // is needs_human, with the parse errors surfaced. (Found by dogfooding: a
  // diff-truncated file missing its closing brace was marked allow / ready.)
  const finalFiles = resolvedFiles({ diff: run.diff, changes });
  const syntax = checkSyntax(finalFiles);
  // Phantom-dependency gate: a change that imports a package not in package.json
  // always fails CI ("Cannot find module") - it can never hand off. Enforced, not
  // just advised by grounding. No-op when installedRoots is empty (unknown deps).
  const phantomImports = findPhantomImports(finalFiles, installedRoots);
  // Completeness gate: a test file with no test case parses but jest fails it
  // ("must contain at least one test") - it can never go green, so it never hands
  // off (the apex fragment that slipped past the syntax gate).
  const incompleteFiles = findIncompleteFiles(finalFiles);
  // Export/API-preservation gate: an edit that DROPS a public export breaks every
  // importer (the apex `decide` deletion that broke five modules and passed the
  // syntax check, since the file still parsed). Compare each edited file's exports
  // on the repo's base vs the authored version; a removed export blocks handoff
  // and escalates to a human (a real refactor sometimes removes one, so it is
  // escalate-not-deny). New files have no "before" and never flag. Best-effort +
  // no-op without a repo/token; absence of before-content never blocks a handoff.
  const removedExports: RemovedExport[] = [];
  if (repo) {
    try {
      const gh = await workspaceGithubClient(workspaceId);
      if (gh.token) {
        for (const f of finalFiles) {
          const before = await fetchFileContent(gh, repo, f.path).catch(() => null);
          if (before) for (const name of findRemovedExports(before, f.content)) removedExports.push({ path: f.path, name });
        }
      }
    } catch {
      /* best-effort: if we cannot read the base file, do not block on it */
    }
  }

  // Local-import gate: an import of a `@/`-alias or relative module that resolves
  // to NO file, or of a named symbol a readable local module does NOT export,
  // always fails CI ("Cannot find module" / "has no exported member"). It slips
  // past the phantom gate (bare packages only) AND the syntax gate (it parses).
  // This is the exact hole that shipped a red WWP guest-export PR: `listAllGuests`
  // from a real module that does not export it, `recordEvent` from the WRONG
  // module, and a non-existent `@/lib/test-helpers`. Existence is judged against
  // the repo tree (authoritative, one call); a name is judged against the target
  // module's fetched source and FAILS OPEN when the source is unread or the module
  // re-exports with `export *`. No-op without a repo tree (unknown => never flag).
  // Same check the author-retry used, re-run on the FINAL draft: if a self-heal
  // attempt still left a broken local import, it blocks here (needs_human).
  const brokenLocalImports = await checkLocalImports(finalFiles, localImportCtx);

  // DRY GATE: did the change re-implement capability that already exists? The
  // reuse-scout surfaced the existing modules whose names match the task; if the
  // top one is a STRONG match and the change did not import it, this is a likely
  // duplication (the exact failure that shipped a second cost summary, and that
  // the detector-duplication incident repeated). It ESCALATES to a human rather
  // than hard-blocking - a name match is a strong hint, not proof - so the human
  // confirms "reuse it" or "genuinely new". Computed here so it gates the handoff.
  const dupSignal = duplicationSignal(reuseCandidatesList, finalFiles, aliasMap);
  const dupGate = duplicationGate(dupSignal);

  let approvalId: string | null = null;
  if (run.status === "ready_for_pr" && !invariants.wouldBlock && !deepScan.blocking && !dupGate.escalate && filesModeHandoffOk && syntax.ok && phantomImports.length === 0 && incompleteFiles.length === 0 && removedExports.length === 0 && anchorFailures.length === 0 && brokenLocalImports.length === 0) {
    // Provision the factory's own governed principal (active + revocable) and hand
    // the approval its REAL agent id, so the human-in-the-gate approval's
    // kill-switch re-check finds an active agent instead of auto-rejecting. A null
    // id (no database) degrades to "no handoff", never a thrown request.
    const codeGateAgentId = await ensureCodeGateAgent(workspaceId, auth.user.id, {
      userId: auth.user.id,
      role: auth.user.role,
    });
    if (codeGateAgentId) {
      approvalId = await createPendingApproval({
        workspaceId,
        agentId: codeGateAgentId,
        ownerUserId: auth.user.id,
        tool: "ai_code.open_pr",
        params: {
          ref,
          prompt,
          // Target repo for the PR; the executor defaults to apex (self-hosting)
          // when absent. Not user-secret; a human sees exactly what they approve.
          repo,
          spec_hash: run.spec.hash,
          conforms: run.conformance.conforms,
          // The gate ALLOWED this change, so it carries no secret to store; a human
          // sees exactly what they are approving. In files mode the commit uses the
          // full-file changes; in diff mode it uses the diff's new files.
          diff: run.diff,
          ...(changes ? { changes } : {}),
        },
        capability: "settings.manage_team",
      });
    }
  }

  // Cost meter: what the run cost + what the same tokens would cost on other
  // popular models (reuses the router's pricing registry). Iteration overhead
  // (repair attempts) is the measurable hidden cost of a cheaper model.
  const cost = buildRunCost({
    actualUsd: executor?.costUsd ?? null,
    inputTokens: executor?.inputTokens ?? null,
    outputTokens: executor?.outputTokens ?? null,
    repairAttempts: run.remediation.attempts.length,
  });

  // A change that does not parse, or imports a local symbol that does not exist,
  // is never "ready_for_pr" whatever the gate said - both always fail CI.
  const effectiveRun =
    syntax.ok && brokenLocalImports.length === 0 && !dupGate.escalate ? run : { ...run, status: "needs_human" as const };

  // A retry happened AND the final draft is clean of every self-healable class:
  // the model RECOVERED from its own mistake given the exact feedback. The single
  // most valuable per-model signal - it separates "got it right first try" from
  // "needed a nudge" from "could not be nudged".
  const selfHealed =
    executorAttempts > 1 && syntax.ok && phantomImports.length === 0 && incompleteFiles.length === 0 && brokenLocalImports.length === 0;

  // AWAITED (backs Run history) + the per-run FAILURE TAXONOMY, so every run is a
  // labeled datapoint for grading a model's real limits as we switch models:
  // which deterministic gate each model trips, how often, and whether it recovers
  // from feedback. This is the dataset the dogfooding generates; record all of it.
  await trackEventAwait("ai_code.pipeline_run", auth.user.id, auth.user.role, {
    workspace_id: workspaceId, // scopes the run history + grading read (multi-tenant safe)
    repo: repo ?? "(self)",
    ref,
    spec_hash: run.spec.hash,
    status: effectiveRun.status, // the EFFECTIVE outcome (a gate block downgrades to needs_human)
    attempts: run.remediation.attempts.length,
    final_outcome: run.review.verdict.outcome,
    open_questions: run.openQuestions.length,
    conforms: run.conformance.conforms,
    // Per-model attribution (src/lib/ai-code/grading.ts).
    model: effectiveAuthor,
    mode: effectiveMode,
    cost_usd: executor?.costUsd ?? 0,
    executor_attempts: executorAttempts,
    self_healed: selfHealed,
    handed_off: approvalId !== null,
    repo_context_files: repoContextFiles.length,
    reuse_candidates: reuseCandidates,
    // SHADOW duplication signal (reuse-enforcement.ts): the top existing module
    // the scout surfaced + whether the change reused it. Recorded, NOT enforced -
    // a high score that went unreused is likely a re-implementation, and this
    // data is what sets the escalation threshold before we turn enforcement on.
    reuse_top_score: dupSignal.topScore,
    ...(dupSignal.topReused !== null ? { reuse_top_reused: dupSignal.topReused } : {}),
    // The DRY gate decision: did a strong existing module go un-reused (a likely
    // re-implementation the gate escalated to a human)? Now ENFORCED, not shadow.
    reuse_duplication_escalated: dupGate.escalate,
    // The failure taxonomy: which deterministic gate fired on the FINAL draft.
    syntax_ok: syntax.ok,
    phantom_imports: phantomImports.length,
    broken_local_imports: brokenLocalImports.length,
    incomplete_files: incompleteFiles.length,
    removed_exports: removedExports.length,
    anchor_failures: anchorFailures.length,
    deep_scan_critical: deepScan.critical,
    deep_scan_high: deepScan.high,
    // The change itself, so history shows the code, not just the grade. Capped.
    diff: run.diff.slice(0, HISTORY_DIFF_CAP),
    diff_truncated: run.diff.length > HISTORY_DIFF_CAP,
    verdict_reason: run.review.verdict.reason,
  });

  return NextResponse.json({ run: effectiveRun, approvalId, executor, invariants, changeFacts, deepScan, duplication: dupGate, syntax, phantomImports, incompleteFiles, removedExports, anchorFailures, brokenLocalImports, selfHealed, mode: effectiveMode, executorAttempts, repoContext: { files: repoContextFiles }, cost });
}
