/**
 * The combined pre-PR assessment: run a change through ALL deterministic gate
 * layers at once and return the single handoff decision. This is the exact
 * condition the pipeline uses to hand off (security gate allows AND no invariant
 * blocks AND the deep scan is clean AND no protected route ships without auth
 * AND no known-compromised package version is resolved), extracted so it can be
 * proven as one thing over a corpus - and reused rather than re-expressed.
 *
 * Deterministic: no model. Same change in, same decision out. The model authors;
 * THIS decides whether what it authored may reach a human.
 *
 * POST-IMAGES. A real PR diff only carries the hunks of a MODIFIED file, so the
 * deep scan used to see new files only. When the caller passes `changedFiles`
 * (the full post-image of each changed file, e.g. fetched at the PR head with
 * fetchFileContent), modified files are deep-scanned too. Precision: a finding in
 * a modified file is kept only when it sits on a line the change ADDED, so a
 * pre-existing issue the PR did not touch never blocks it. A diff synthesized by
 * filesToDiff marks every line as added ("new file mode"), so in files mode every
 * file is new and every finding counts, which is the existing behavior.
 */
import { reviewDiff } from "./detect";
import { decideCodeGate } from "./gate";
import { evaluateChangeInvariants, type ChangeInvariantInput } from "./change-facts";
import { deepScanChange } from "./deep-scan";
import { newFilesFromDiff } from "./oracle";
import { findMissingAuth, isProtectedApiRoute } from "./missing-auth";
import { isOurRepo } from "./selfhost-mode";
import {
  checkLockfileCompromise,
  type KnownCompromisedLoad,
  type LockfileCompromiseResult,
} from "@/lib/platform-scan/static/lockfile-compromise";
import type { ScanFinding } from "@/lib/platform-scan/types";

export const DEFAULT_ASSESS_REPO = "the-wolfpack-agency/wolfpack-apex";

export interface ChangeAssessment {
  securityOutcome: "allow" | "escalate" | "block";
  invariantRuleId: string;
  invariantBlocked: boolean;
  deepScanCritical: number;
  deepScanBlocking: boolean;
  /** CWE-862: protected API routes in the change with no authorization control.
   *  Only evaluated on repos whose protected-module convention the rule encodes. */
  missingAuth?: { evaluated: boolean; findings: ScanFinding[] };
  /** Known-compromised package versions the change resolves in a lockfile. */
  compromisedDependencies?: LockfileCompromiseResult;
  /** True only when every layer clears the change for human handoff. */
  handoffAllowed: boolean;
  /** Which layer stopped it (first that applies), or null when allowed. */
  blockedBy: "security" | "invariant" | "deep-scan" | "missing-auth" | "compromised-dependency" | null;
}

export interface AssessChangeContext {
  /** Full post-image contents of the changed (new AND modified) files. */
  changedFiles?: readonly { path: string; content: string }[];
  /** The repo the change targets. The deep scan defaults to this repo (the
   *  factory's target). The CWE-862 layer runs ONLY when this is given AND is one
   *  of our own repos: an unspecified repo (e.g. the client-facing safe-review
   *  gate) is never judged by our protected-module convention. */
  repoFullName?: string;
  /** Injected known-compromised list loader (tests). Defaults to the repo file. */
  loadKnownCompromised?: () => KnownCompromisedLoad;
}

/** Post-image line numbers each file section of a unified diff ADDS. Pure. */
export function addedLineNumbers(diff: string): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  let path = "";
  let line = 0;
  let inHunk = false;
  for (const l of diff.split("\n")) {
    if (l.startsWith("diff --git")) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(l);
      path = m ? m[2].trim() : "";
      inHunk = false;
      continue;
    }
    if (!inHunk && l.startsWith("+++ ")) {
      const m = /^\+\+\+ b\/(.+)$/.exec(l);
      if (m) path = m[1].trim();
      continue;
    }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (h) {
      line = Number(h[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk || !path) continue;
    if (l.startsWith("+")) {
      if (!out.has(path)) out.set(path, new Set());
      out.get(path)!.add(line);
      line++;
    } else if (l.startsWith("-") || l.startsWith("\\")) {
      // removed line / "\ No newline": does not advance the post-image counter
    } else {
      line++;
    }
  }
  return out;
}

/** Post-image paths the diff touches (deleted files excluded). Pure. Used by
 *  callers that fetch post-images to pass as `changedFiles`. */
export function changedPathsFromDiff(diff: string): string[] {
  const out: string[] = [];
  let pending: string | null = null;
  for (const l of diff.split("\n")) {
    if (l.startsWith("diff --git")) {
      if (pending) out.push(pending);
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(l);
      pending = m ? m[2].trim() : null;
      continue;
    }
    if (pending && l.startsWith("+++ /dev/null")) pending = null; // deleted
    if (l.startsWith("Binary files")) pending = null;
  }
  if (pending) out.push(pending);
  return Array.from(new Set(out));
}

/** Keep a finding from a MODIFIED file only when it is on a line the change added. */
function onAddedLine(f: ScanFinding, added: Map<string, Set<number>>): boolean {
  const path = typeof f.evidence?.path === "string" ? f.evidence.path : f.route;
  const line = f.evidence?.line;
  if (typeof line !== "number") return false; // precision first: no line, no claim
  return added.get(path)?.has(line) ?? false;
}

export async function assessChange(
  diff: string,
  opts: ChangeInvariantInput = {},
  ctx: AssessChangeContext = {},
): Promise<ChangeAssessment> {
  const repoFullName = ctx.repoFullName ?? DEFAULT_ASSESS_REPO;
  // The factory's own pipeline route already runs findMissingAuth on its output;
  // here it runs only for a change explicitly targeting one of our repos.
  const missingAuthEvaluated = ctx.repoFullName !== undefined && isOurRepo(ctx.repoFullName);
  const security = decideCodeGate(reviewDiff(diff));
  const { decision: inv } = evaluateChangeInvariants(diff, opts);

  // Deep scan over new files (from the diff) plus every post-image the caller
  // supplied. New-file findings all count; modified-file findings must sit on an
  // added line.
  const newFiles = newFilesFromDiff(diff);
  const merged: Record<string, string> = Object.create(null);
  for (const [p, c] of Object.entries(newFiles)) merged[p] = c;
  for (const c of ctx.changedFiles ?? []) merged[c.path] = c.content;
  const files = Object.entries(merged).map(([path, content]) => ({ path, content }));
  const deep = await deepScanChange(diff, repoFullName, files);
  const added = addedLineNumbers(diff);
  const deepFindings = deep.findings.filter((f) => {
    const path = typeof f.evidence?.path === "string" ? f.evidence.path : f.route;
    return path in newFiles || onAddedLine(f, added);
  });
  const deepCritical = deepFindings.filter((f) => f.severity === "critical").length;
  const deepBlocking = deepCritical > 0;

  // CWE-862: the protected-module list is THIS repo's convention (it mirrors
  // capability-coverage.test.ts), so it runs only on our own repo. On a client
  // repo the same path shape can be gated by anything (NextAuth, middleware), and
  // judging it by our list would be a false positive.
  const missingAuthFindings = missingAuthEvaluated
    ? findMissingAuth(files.filter((f) => isProtectedApiRoute(f.path)))
    : [];
  const missingAuthBlocking = missingAuthFindings.length > 0;

  const compromised = checkLockfileCompromise(diff, { repoFullName, load: ctx.loadKnownCompromised });
  const compromisedBlocking = compromised.findings.length > 0;

  const securityBlocked = security.outcome !== "allow";
  const handoffAllowed =
    !securityBlocked && !inv.wouldBlock && !deepBlocking && !missingAuthBlocking && !compromisedBlocking;
  const blockedBy: ChangeAssessment["blockedBy"] = securityBlocked
    ? "security"
    : inv.wouldBlock
      ? "invariant"
      : deepBlocking
        ? "deep-scan"
        : missingAuthBlocking
          ? "missing-auth"
          : compromisedBlocking
            ? "compromised-dependency"
            : null;

  return {
    securityOutcome: security.outcome,
    invariantRuleId: inv.ruleId,
    invariantBlocked: inv.wouldBlock,
    deepScanCritical: deepCritical,
    deepScanBlocking: deepBlocking,
    missingAuth: { evaluated: missingAuthEvaluated, findings: missingAuthFindings },
    compromisedDependencies: compromised,
    handoffAllowed,
    blockedBy,
  };
}
