/**
 * The Secure Agent gate: enforce best-practice rules on a produced change,
 * before it can reach a human for merge.
 *
 * THE ONE PRINCIPLE THIS ENCODES
 *
 * Models advise; deterministic policy decides. The zero-token scanners
 * (platform-scan static detectors) find the issues and make the block/pass
 * call. An independent-family model judge runs only on what survives the scan,
 * to CONFIRM or REFUTE the softer, noisier findings and cut false positives —
 * it can never overturn a hard-block, and it is never the gate. This is the
 * exact failure mode that a rule-in-prose-only produced (a reset link logged
 * under pressure): here the rule is a check, and the check decides.
 *
 * WHY THE JUDGE IS A DIFFERENT FAMILY
 *
 * A model marking its own family's homework correlates on blind spots and
 * agrees exactly where the author was most likely wrong. Judge selection reuses
 * chooseIndependentJudge (src/lib/ai/judge-selection.ts): a judge of a
 * different LINEAGE, or the finding is recorded UNCHECKED. It never falls back
 * to a sibling.
 *
 * WHAT THIS MODULE DOES NOT DO YET
 *
 * It computes a verdict; it does not itself write the OGIAM ledger or re-route
 * to another model. Those are the API adapter (Stage 2) and are injected here
 * as an optional `audit` sink, so the decision stays pure and testable without
 * a database.
 */
import type { ScanFinding } from "@/lib/platform-scan/types";
import { runDetectors } from "@/lib/platform-scan/static/detectors";
import { chooseIndependentJudge, type JudgeCandidate } from "@/lib/ai/judge-selection";

export type GateDecision = "block" | "pass";

export interface SecureAgentFile {
  path: string;
  content: string;
}

/** The judge's verdict on a single finding. */
export type FindingVerdict = "confirmed" | "false_positive" | "needs_review";

/**
 * Confirm/refute one finding using a specific, independent judge model.
 * Injected so the pipeline is testable with no network; in production this
 * wraps router.complete() pinned to the chosen candidate's provider/model, on a
 * cheap model (independence is by family, not tier).
 */
export type FindingJudge = (args: {
  candidate: JudgeCandidate;
  finding: ScanFinding;
}) => Promise<{ verdict: FindingVerdict; reason: string }>;

export interface FindingJudgment {
  finding: ScanFinding;
  /** "unchecked" = no different-family judge was available (fail-loud). */
  verdict: FindingVerdict | "unchecked";
  authorLineage: string;
  judgeLineage: string | null;
  reason: string;
}

export interface SecureAgentVerdict {
  decision: GateDecision;
  /** Findings that caused the block. */
  blocking: ScanFinding[];
  /** Non-blocking findings surfaced to the user (the warnings list). */
  warnings: ScanFinding[];
  judgments: FindingJudgment[];
  /** True when independence could not be demonstrated for a judged finding. */
  unchecked: boolean;
}

export interface SecureAgentInput {
  /** The produced change under review, a diff expressed as changed files. */
  files: SecureAgentFile[];
  /** Who authored the change, so the judge is a DIFFERENT family. */
  author?: JudgeCandidate;
  /** Judge models available to check the work, cheapest-first. */
  judgeCandidates?: readonly JudgeCandidate[];
  /** Independent-family judge. Omit to skip the LLM judge; the deterministic
   *  gate still decides. */
  judge?: FindingJudge;
  /** Cost cap: judge at most this many findings (AgenticQA-style top-N). */
  maxJudged?: number;
  /** Optional audit sink (OGIAM ledger + analytics adapter). Best-effort:
   *  a failure here never changes the decision already made. */
  audit?: (verdict: SecureAgentVerdict) => void | Promise<void>;
}

/**
 * A finding the gate blocks on regardless of any model's opinion: a critical
 * anything, or a high-severity SECURITY issue — the precise classes where the
 * detector's false-positive rate is near zero. Logging a reset link / secret is
 * exactly here (secretInLogs emits critical/high security).
 */
function isHardBlock(f: ScanFinding): boolean {
  return f.severity === "critical" || (f.severity === "high" && f.category === "security");
}

export async function runSecureAgentGate(input: SecureAgentInput): Promise<SecureAgentVerdict> {
  // 1. Deterministic scan over every changed file (zero-token; does the work).
  const findings: ScanFinding[] = [];
  for (const file of input.files) findings.push(...runDetectors(file));

  const hardBlocks = findings.filter(isHardBlock);
  const softFindings = findings.filter((f) => !isHardBlock(f));

  // 2. Independent-family judge, cost-capped, only on scan survivors. Selection
  //    is computed ONCE (pure); a null candidate means every judged finding is
  //    UNCHECKED rather than judged by a sibling.
  const judgments: FindingJudgment[] = [];
  let unchecked = false;
  const confirmedSoft = new Set<ScanFinding>();

  if (input.judge && input.author) {
    const cap = input.maxJudged ?? 20;
    const toJudge = [...hardBlocks, ...softFindings].slice(0, cap);
    const choice = chooseIndependentJudge(input.author, input.judgeCandidates ?? []);

    for (const finding of toJudge) {
      if (!choice.candidate) {
        unchecked = true;
        judgments.push({
          finding,
          verdict: "unchecked",
          authorLineage: choice.authorLineage,
          judgeLineage: null,
          reason: choice.reason,
        });
        continue;
      }
      try {
        const r = await input.judge({ candidate: choice.candidate, finding });
        judgments.push({
          finding,
          verdict: r.verdict,
          authorLineage: choice.authorLineage,
          judgeLineage: choice.judgeLineage,
          reason: r.reason,
        });
        if (r.verdict === "confirmed" && !isHardBlock(finding)) confirmedSoft.add(finding);
      } catch {
        // A judge that errors leaves the finding as the scanner classified it;
        // it can never turn a block into a pass.
        unchecked = true;
        judgments.push({
          finding,
          verdict: "unchecked",
          authorLineage: choice.authorLineage,
          judgeLineage: choice.judgeLineage,
          reason: "judge_unreachable",
        });
      }
    }
  }

  // 3. Gate decision, fail-closed. A hard-block finding blocks, full stop. A
  //    soft finding blocks only when the independent judge CONFIRMED it.
  const blocking = [...hardBlocks, ...softFindings.filter((f) => confirmedSoft.has(f))];
  const warnings = softFindings.filter((f) => !confirmedSoft.has(f));
  const decision: GateDecision = blocking.length > 0 ? "block" : "pass";

  const verdict: SecureAgentVerdict = { decision, blocking, warnings, judgments, unchecked };

  // 4. Record (best-effort). The decision is already made; recording never
  //    changes it. Ledger/analytics wiring lives in the API adapter.
  if (input.audit) {
    try {
      await input.audit(verdict);
    } catch {
      /* intentionally swallowed: see comment above */
    }
  }

  return verdict;
}
