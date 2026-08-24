/**
 * The reality check reported SUCCESS while twelve tests failed.
 *
 * Its soft-spec step runs 24 specs under continue-on-error and is named
 * "post-merge visibility". There was no visibility: a step that cannot fail
 * produces a green tick, and the last green run on main contained
 * "12 failed, 7 skipped, 30 passed". Several of those failures were the
 * loading-screen bug that also kept Verify red for two months, and nobody saw
 * either, for the same reason.
 *
 * Deleting continue-on-error is the wrong fix. Some of these specs mutate real
 * state and genuinely flake, and blocking every merge on them would get the
 * whole step deleted within a week. What is wrong is not that they can fail,
 * it is that failing costs nothing and is invisible.
 *
 * So: a ratchet. The known-failing set is written down. A failure already on
 * the list is reported and tolerated. A failure that is NOT on the list fails
 * the job. The pile can shrink and cannot silently grow.
 *
 * When a listed failure starts passing, that is said out loud so the entry can
 * be removed, but it does not fail the run: a fix should never break a build.
 */

export interface SpecOutcome {
  /** `tests/e2e/x.spec.ts › describe › test`, stable across line moves. */
  key: string;
  status: "passed" | "failed" | "flaky" | "skipped";
}

export interface RatchetReport {
  /** Failing and not on the list. These fail the job. */
  newFailures: string[];
  /** Failing and expected. Reported, tolerated. */
  knownFailures: string[];
  /** On the list but passing now. Remove them; does not fail the job. */
  nowPassing: string[];
  /** On the list but absent from the run: renamed, deleted or never ran. */
  missing: string[];
  /** Passed on retry. Worth seeing, never fatal. */
  flaky: string[];
  total: number;
}

/** Playwright's JSON report, only the parts this reads. */
interface PwSuite {
  title?: string;
  file?: string;
  specs?: Array<{
    title: string;
    tests?: Array<{ status?: string }>;
  }>;
  suites?: PwSuite[];
}

/**
 * Playwright reports `file` RELATIVE TO testDir, so a spec arrives as
 * "agents-onboarding.spec.ts", not "tests/e2e/agents-onboarding.spec.ts".
 * A baseline written in the second form would match nothing, every known
 * failure would read as new, and the ratchet would fail main on its first run
 * while looking entirely correct. Found by running the parser against a real
 * report rather than assuming the shape.
 *
 * Both forms, and an absolute path, normalize to the repo-relative one.
 */
export function normalizeFile(file: string): string {
  return `tests/e2e/${file.replace(/^.*tests[/\\]e2e[/\\]/, "")}`;
}

/**
 * Flatten Playwright's nested report into one outcome per spec.
 *
 * The top-level suite's title IS the file path, so it is dropped from the
 * trail; every nested suite title is a describe block. Keying on titles rather
 * than line numbers means moving a test up a file does not read as a new
 * failure, which would make the ratchet fire on an unrelated edit and teach
 * everyone to ignore it.
 */
export function parseResults(report: unknown): SpecOutcome[] {
  const out: SpecOutcome[] = [];
  const root = (report as { suites?: PwSuite[] })?.suites ?? [];

  const walk = (suite: PwSuite, file: string, trail: string[]) => {
    const f = suite.file ?? file;
    const isFileSuite = !suite.title || suite.title === f;
    const next = isFileSuite || !suite.title ? trail : [...trail, suite.title];
    for (const spec of suite.specs ?? []) {
      const statuses = (spec.tests ?? []).map((t) => t.status);
      const status: SpecOutcome["status"] = statuses.includes("unexpected")
        ? "failed"
        : statuses.includes("flaky")
          ? "flaky"
          : statuses.length > 0 && statuses.every((s) => s === "skipped")
            ? "skipped"
            : "passed";
      out.push({ key: [normalizeFile(f), ...next, spec.title].join(" › "), status });
    }
    for (const s of suite.suites ?? []) walk(s, f, next);
  };

  for (const s of root) walk(s, s.file ?? "", []);
  return out;
}

export function compare(
  outcomes: SpecOutcome[],
  baseline: Record<string, string>,
): RatchetReport {
  const known = new Set(Object.keys(baseline));
  const seen = new Set(outcomes.map((o) => o.key));
  const failed = outcomes.filter((o) => o.status === "failed").map((o) => o.key);
  return {
    newFailures: failed.filter((k) => !known.has(k)).sort(),
    knownFailures: failed.filter((k) => known.has(k)).sort(),
    nowPassing: outcomes
      .filter((o) => o.status === "passed" && known.has(o.key))
      .map((o) => o.key)
      .sort(),
    missing: [...known].filter((k) => !seen.has(k)).sort(),
    flaky: outcomes.filter((o) => o.status === "flaky").map((o) => o.key).sort(),
    total: outcomes.length,
  };
}
