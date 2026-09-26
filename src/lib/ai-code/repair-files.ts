/**
 * Files-native repair: the auto-fix loop at the GATE, before a PR opens.
 *
 * The diff-native repair (repair.ts) re-authors a unified diff; it does not map
 * to full-file mode. This is the full-file analog: assess the authored files, and
 * if the combined gate does not clear them, re-author the WHOLE files with the
 * gate's feedback and re-assess, bounded, until clear or handed to a human. The
 * re-author is injected so the caller can route it to a DIFFERENT lineage (no
 * same-family fix of a same-family mistake), the same independence rule the judge
 * and the diff-repair use.
 *
 * Pure orchestration over assessChange + an injected re-author. The gate decides;
 * the model only re-writes.
 */
import { filesToDiff, type FileChange } from "./file-changes";
import { assessChange, type ChangeAssessment } from "./assess";
import type { AuthorFilesResult } from "./author";

export interface FileRepairResult {
  status: "clean" | "needs_human";
  /** The final set of changes (the last authored, whether it passed or not). */
  changes: FileChange[];
  author: string;
  attempts: { author: string; blockedBy: ChangeAssessment["blockedBy"] }[];
  reason: string;
}

/** Turn a blocking assessment into a short, instruction-free brief for the re-author. */
export function repairBrief(a: ChangeAssessment): string {
  if (a.blockedBy === "security") return `The security gate blocked the change (${a.securityOutcome}). Remove the flagged issue; do not weaken any test.`;
  if (a.blockedBy === "invariant") return `An engineering invariant blocked the change (${a.invariantRuleId}). Satisfy it (e.g. avoid the new dependency / the disallowed pattern).`;
  if (a.blockedBy === "deep-scan") return `The deep static scan found ${a.deepScanCritical} critical issue(s) (e.g. a hardcoded secret). Remove it; reference a secret store, never inline it.`;
  return "The change did not pass the gate; address the reported issue without weakening tests.";
}

export async function remediateFileChanges(args: {
  initial: FileChange[];
  initialAuthor: string;
  /** Re-author the WHOLE change given the gate feedback. Route to a different
   *  lineage than initialAuthor for independence. Returns full-file changes. */
  reauthor: (feedback: string) => Promise<AuthorFilesResult>;
  maxAttempts?: number;
  /** Injected for tests; defaults to the real combined gate over a files diff. */
  assess?: (changes: FileChange[]) => Promise<ChangeAssessment>;
}): Promise<FileRepairResult> {
  const maxAttempts = args.maxAttempts ?? 2;
  const assess = args.assess ?? ((c: FileChange[]) => assessChange(filesToDiff(c)));

  let changes = args.initial;
  let author = args.initialAuthor;
  const attempts: FileRepairResult["attempts"] = [];

  let a = await assess(changes);
  if (a.handoffAllowed) {
    return { status: "clean", changes, author, attempts, reason: "the change passed the gate as authored" };
  }

  for (let n = 0; n < maxAttempts; n++) {
    attempts.push({ author, blockedBy: a.blockedBy });
    const reauthored = await args.reauthor(repairBrief(a));
    // A re-author that produced nothing usable ends the loop at the human.
    if (reauthored.error || reauthored.changes.length === 0) {
      return { status: "needs_human", changes, author, attempts, reason: `re-author produced no usable change (${reauthored.error ?? "empty"})` };
    }
    changes = reauthored.changes;
    author = reauthored.author;
    a = await assess(changes);
    if (a.handoffAllowed) {
      return { status: "clean", changes, author, attempts, reason: `the gate cleared the change after ${attempts.length} repair attempt(s)` };
    }
  }

  attempts.push({ author, blockedBy: a.blockedBy });
  return { status: "needs_human", changes, author, attempts, reason: `still blocked by ${a.blockedBy} after ${maxAttempts} repair attempt(s)` };
}
