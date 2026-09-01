/**
 * Which model writes code that survives our gate, and what it costs per task
 * that actually ships.
 *
 * WHY CODE IS THE ONE PLACE THIS CAN BE MEASURED HONESTLY
 *
 * Routing to a cheaper model is a claim until something objective checks the
 * result. For prose, verification.ts gets partway: it catches empty, truncated
 * and refused, and cannot judge whether a correct-looking answer is correct.
 * For code that gap closes, because CI is a real oracle. It is objective, free,
 * repeatable, and it scores exactly the thing being bought: does this survive
 * the gate. Not "does it feel smart".
 *
 * That oracle is only as strong as the gate behind it. A leaderboard scored by
 * a weak test suite ranks noise. This repo's gate is 9 stages and ~19,000
 * tests with ratchets on top, which is what makes a pass here mean something
 * and is the part that cannot be bought.
 *
 * THE METRIC IS COST PER PASSING TASK, AND THAT IS THE WHOLE POINT
 *
 * Price per call is the advertised unit. It is not the cost. A model at a tenth
 * the price that passes a third as often is more expensive per shipped change,
 * and it looks cheaper in every dashboard that reports spend per call.
 *
 * Which produces the trap this module exists to refuse: a model that passes
 * NOTHING has the lowest cost per call on the board, and dividing its spend by
 * zero passes is not "cheap", it is undefined. scoreScreen reports that as
 * unranked with the reason attached rather than sorting it to the top.
 *
 * AND THE ORACLE CAN BE GAMED, WHICH IS THE REST OF THE MODULE
 *
 * "Make the gate pass" has a trivial solution: delete the failing test. A model
 * that does this scores a perfect pass rate while producing the single worst
 * change in the set, and every number downstream is then measuring the wrong
 * thing with total confidence.
 *
 * So a patch is judged BEFORE it is ever run. Touching the task's own test,
 * weakening the gate that grades it, or removing test cases on net are all
 * disqualifying, and disqualified is a distinct outcome from failed: one model
 * could not do the work, the other tried to change the rules, and collapsing
 * them would hide the more important finding.
 */

/** One task the screen asks every model to perform. */
export interface CodeTask {
  /** Stable id, used to join results across runs. */
  id: string;
  /** What the model is asked to do, in the words a person would use. */
  prompt: string;
  /**
   * The commit BEFORE this change landed. The runner builds its worktree here
   * so the model sees the code with the problem still in it. Without this the
   * screen hands over the answer and measures nothing.
   */
  baseCommit: string;
  /** The single source file the model is asked to write. */
  targetFile: string;
  /**
   * The test files that decide this task, which the patch may NEVER touch.
   * They are the exam paper; a candidate that edits it has not passed it.
   */
  gradedBy: string[];
}

/** Why a patch was rejected before it was allowed to run. */
export type GamingReason =
  /** Edited the test that grades this very task. */
  | "edited_graded_test"
  /** Changed the gate, the runner config, or CI itself. */
  | "weakened_the_gate"
  /** Removed test cases on net across the whole patch. */
  | "deleted_test_cases";

/**
 * Files that grade every task, whatever the task is. A change here rewrites the
 * rules for the entire suite rather than for one exam, so it is disqualifying
 * regardless of which task was being attempted.
 */
const GATE_FILES = [
  "scripts/verify.sh",
  "jest.config.ts",
  "jest.setup.ts",
  "eslint.config.mjs",
  "tsconfig.json",
  "playwright.config.ts",
];

/** A gate file, or anything under the CI workflow directory. */
function isGateFile(path: string): boolean {
  const p = path.replace(/^\.\//, "");
  return GATE_FILES.includes(p) || p.startsWith(".github/workflows/");
}

/**
 * Count the test cases a patch adds and removes.
 *
 * Deliberately counts DECLARATIONS in +/- lines rather than parsing, because
 * this runs on a unified diff and a parser would need the whole post-image of
 * every file. The failure mode of counting is a miscount on an exotic
 * formatting; the failure mode of not checking at all is a model scoring 100%
 * by deleting the suite.
 */
export function countTestCaseDelta(patch: string): { added: number; removed: number } {
  /* it/test/describe with either quote style, or a .each table. Matches the
     declaration, not a call to a function that happens to be named test. */
  const DECL = /^\s*(?:it|test|describe)(?:\.(?:each|only|skip|todo|concurrent|failing)\b[^(]*)?\s*[(`]/;
  let added = 0;
  let removed = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+") && DECL.test(line.slice(1))) added++;
    else if (line.startsWith("-") && DECL.test(line.slice(1))) removed++;
  }
  return { added, removed };
}

/** Every file a unified diff touches. */
export function filesTouchedByPatch(patch: string): string[] {
  const files = new Set<string>();
  for (const line of patch.split("\n")) {
    /* Read the b/ side: it names the file after the change, which is what a
       rename or a delete has to be judged on. */
    const m = /^\+\+\+ b\/(.+)$/.exec(line) ?? /^diff --git a\/\S+ b\/(.+)$/.exec(line);
    if (m && m[1] && m[1] !== "/dev/null") files.add(m[1].trim());
  }
  return [...files];
}

export interface GamingVerdict {
  gamed: boolean;
  reasons: GamingReason[];
  /** The specific files that triggered it, so a rejection is auditable. */
  offendingFiles: string[];
}

/**
 * Judge the patch before running it.
 *
 * FAILS CLOSED. Everywhere else in this codebase degrading gracefully is right;
 * here an unreadable patch that gets the benefit of the doubt is a patch that
 * scores. An empty or unparseable diff produces no offending files and is
 * simply not gamed, but it will fail the gate on its own merits, which is the
 * correct outcome and needs no special case.
 */
export function detectOracleGaming(patch: string, task: CodeTask): GamingVerdict {
  const touched = filesTouchedByPatch(patch);
  const reasons: GamingReason[] = [];
  const offending = new Set<string>();

  /* Normalized both sides: the task names its graded tests as repo-relative
     paths and a diff may carry a leading ./ */
  const graded = new Set(task.gradedBy.map((f) => f.replace(/^\.\//, "")));
  for (const f of touched) {
    if (graded.has(f.replace(/^\.\//, ""))) {
      if (!reasons.includes("edited_graded_test")) reasons.push("edited_graded_test");
      offending.add(f);
    }
    if (isGateFile(f)) {
      if (!reasons.includes("weakened_the_gate")) reasons.push("weakened_the_gate");
      offending.add(f);
    }
  }

  /* Net removal only. A refactor that renames tests moves the count on both
     sides and is not an attack; deleting more than was added is. */
  const delta = countTestCaseDelta(patch);
  if (delta.removed > delta.added) {
    reasons.push("deleted_test_cases");
  }

  return { gamed: reasons.length > 0, reasons, offendingFiles: [...offending] };
}

/** What happened to one model on one task. */
export type AttemptOutcome =
  /** Produced a patch that survived the gate. */
  | "passed"
  /** Produced a patch that did not survive the gate. */
  | "failed"
  /** Produced a patch that tried to change the rules. Never run. */
  | "disqualified"
  /** Produced nothing usable: refused, empty, or no diff in the reply. */
  | "no_patch"
  /** The call itself did not complete: budget refusal, provider error. */
  | "errored";

export interface ScreenAttempt {
  taskId: string;
  /** The model as the provider named it, not the tier that was asked for. */
  model: string;
  outcome: AttemptOutcome;
  /** The provider's billed figure. Charged whatever the outcome, which is why
   *  a disqualified or failed attempt still counts against cost. */
  costUsd: number;
  latencyMs: number;
  /** Present on disqualified. */
  gaming?: GamingVerdict;
  /** Present on failed: the gate's own first complaint, kept short. */
  gateError?: string;
}

export interface ModelScore {
  model: string;
  attempts: number;
  passed: number;
  failed: number;
  disqualified: number;
  noPatch: number;
  errored: number;
  /** Every dollar this model cost across the screen, passing or not. */
  totalCostUsd: number;
  /** Share of attempts that survived the gate, 0..1. */
  passRate: number;
  /**
   * THE NUMBER THAT DECIDES A ROUTE. Total spend divided by tasks that actually
   * passed, so a model is charged for its failures as it is in real use.
   *
   * Null, never zero and never Infinity, when nothing passed. A model that
   * passed nothing has no cost per passing task, and any number here would sort
   * it against models that did work.
   */
  costPerPassingTaskUsd: number | null;
  meanLatencyMs: number;
}

export interface ScreenResult {
  scores: ModelScore[];
  /** Models that passed at least one task, cheapest per passing task first. */
  ranked: ModelScore[];
  /** Models that passed nothing, kept visible rather than dropped. */
  unranked: ModelScore[];
  /** Cheapest model per passing task, or null when none passed anything. */
  winner: string | null;
  /**
   * What the winner saves against the dearest ranked model, per passing task.
   * Null with fewer than two ranked models: a saving needs something to be
   * cheaper THAN, and reporting one against a field of one is how a screen
   * turns into marketing.
   */
  savingPerTaskUsd: number | null;
  totalCostUsd: number;
}

/**
 * Turn attempts into a leaderboard.
 *
 * Pure: no clock, no network, no ordering assumptions about the input. The
 * runner spends the money and this decides what it meant, which keeps the
 * policy readable and testable without a provider.
 */
export function scoreScreen(attempts: ScreenAttempt[]): ScreenResult {
  const byModel = new Map<string, ScreenAttempt[]>();
  for (const a of attempts) {
    const list = byModel.get(a.model);
    if (list) list.push(a);
    else byModel.set(a.model, [a]);
  }

  const scores: ModelScore[] = [...byModel.entries()].map(([model, list]) => {
    const passed = list.filter((a) => a.outcome === "passed").length;
    const totalCostUsd = list.reduce((s, a) => s + a.costUsd, 0);
    return {
      model,
      attempts: list.length,
      passed,
      failed: list.filter((a) => a.outcome === "failed").length,
      disqualified: list.filter((a) => a.outcome === "disqualified").length,
      noPatch: list.filter((a) => a.outcome === "no_patch").length,
      errored: list.filter((a) => a.outcome === "errored").length,
      totalCostUsd,
      passRate: list.length === 0 ? 0 : passed / list.length,
      /* The division that is refused when it would be meaningless. */
      costPerPassingTaskUsd: passed === 0 ? null : totalCostUsd / passed,
      meanLatencyMs:
        list.length === 0
          ? 0
          : Math.round(list.reduce((s, a) => s + a.latencyMs, 0) / list.length),
    };
  });

  /* Stable order so two runs of the same data read the same way. */
  scores.sort((a, b) => a.model.localeCompare(b.model));

  const ranked = scores
    .filter((s) => s.costPerPassingTaskUsd !== null)
    .sort(
      (a, b) =>
        a.costPerPassingTaskUsd! - b.costPerPassingTaskUsd! || a.model.localeCompare(b.model),
    );
  const unranked = scores.filter((s) => s.costPerPassingTaskUsd === null);

  const dearest = ranked.length >= 2 ? ranked[ranked.length - 1]! : null;

  return {
    scores,
    ranked,
    unranked,
    winner: ranked[0]?.model ?? null,
    savingPerTaskUsd: dearest
      ? dearest.costPerPassingTaskUsd! - ranked[0]!.costPerPassingTaskUsd!
      : null,
    totalCostUsd: scores.reduce((s, m) => s + m.totalCostUsd, 0),
  };
}
