/**
 * Spec-conformance oracle: measure a built change against the FROZEN spec the
 * intake stage agreed, deterministically.
 *
 * This is a measurement, not a security gate. It reads the change's own diff -
 * which files it adds tests to, whether it wires analytics, whether it touches
 * the schema - and reports where that DEVIATES from what the spec committed to
 * (test coverage, data/learning, reversibility). "Measure the real thing, do not
 * eyeball it": the checks are pattern-based over the diff and each deviation is
 * stated in full, so a human sees exactly what was agreed vs what shipped.
 *
 * Precision-first: it flags only clear deviations. A conformant change produces
 * no findings; an ambiguous one is left to the human rather than guessed at.
 */
import { parseAddedLines } from "./detect";
import type { FrozenSpec } from "./intake";

export interface ConformanceFinding {
  /** The spec dimension: "tests" | "data" | "reversibility". */
  requirement: string;
  /** The option the spec committed to. */
  expected: string;
  /** Whether the change satisfies it. */
  ok: boolean;
  /** What was expected vs what the diff shows. */
  detail: string;
}

export interface ConformanceResult {
  specHash: string;
  /** True when every dimension the spec named is satisfied. */
  conforms: boolean;
  findings: ConformanceFinding[];
}

/** The distinct files a diff ADDS lines to. */
function changedFiles(diff: string): string[] {
  return [...new Set(parseAddedLines(diff).map((l) => l.file))];
}

/** All ADDED text, lower-cased, joined - for content pattern checks. */
function addedText(diff: string): string {
  return parseAddedLines(diff)
    .map((l) => l.text)
    .join("\n");
}

function isE2ETest(f: string): boolean {
  return /(^|\/)tests\/e2e\//.test(f) || /\.e2e\.[jt]sx?$/.test(f) || /\.spec\.[jt]sx?$/.test(f);
}
function isContractTest(f: string): boolean {
  return /\.test\.[jt]sx?$/.test(f) && /(^|\/)api\//.test(f);
}
function isUnitTest(f: string): boolean {
  return /\.test\.[jt]sx?$/.test(f) && !isE2ETest(f) && !isContractTest(f);
}

/** Test tiers present among the changed files. */
function testTiers(files: string[]): { unit: boolean; contract: boolean; e2e: boolean } {
  return {
    unit: files.some(isUnitTest),
    contract: files.some(isContractTest),
    e2e: files.some(isE2ETest),
  };
}

function checkTests(expected: string, files: string[]): ConformanceFinding {
  const t = testTiers(files);
  const have: string[] = [];
  if (t.unit) have.push("unit");
  if (t.contract) have.push("contract");
  if (t.e2e) have.push("e2e");
  const found = have.length ? have.join(", ") : "no tests";

  // The tiers are cumulative, matching the option labels.
  let ok: boolean;
  let need: string;
  if (expected === "all") {
    ok = t.unit && t.contract && t.e2e;
    need = "unit, contract and end-to-end tests";
  } else if (expected === "contract") {
    ok = t.unit && t.contract;
    need = "unit and contract tests";
  } else {
    // "unit" (or any unknown value): at least one test.
    ok = t.unit || t.contract || t.e2e;
    need = "at least a unit test";
  }
  return {
    requirement: "tests",
    expected,
    ok,
    detail: ok ? `spec asked for ${need}; the change adds ${found}` : `spec asked for ${need}; the change adds ${found}`,
  };
}

const TRIPLE_WRITE = /triple-?write|triplewrite/i;
const ANALYTICS = /trackevent\s*\(|recordaudit\s*\(/i;
const PERSISTS = /triple-?write|triplewrite|insert\s+into|creatependingapproval\s*\(/i;

function checkData(expected: string, files: string[], text: string): ConformanceFinding {
  if (expected === "durable") {
    const ok = TRIPLE_WRITE.test(text);
    return {
      requirement: "data",
      expected,
      ok,
      detail: ok
        ? "spec asked for a durable entity; the change goes through triple-write"
        : "spec asked for a durable entity but the change does not reference triple-write",
    };
  }
  if (expected === "none") {
    const persists = PERSISTS.test(text) || files.some((f) => /\.sql$/.test(f));
    return {
      requirement: "data",
      expected,
      ok: !persists,
      detail: persists
        ? "spec said no new data, but the change adds persistence (triple-write / INSERT / migration)"
        : "spec said no new data; the change adds none",
    };
  }
  // "analytics" (default): analytics + audit only. Expect a trackEvent/audit
  // call, and NOT a durable triple-write (that would be a stronger commitment).
  const hasAnalytics = ANALYTICS.test(text);
  const durable = TRIPLE_WRITE.test(text);
  const ok = hasAnalytics && !durable;
  return {
    requirement: "data",
    expected,
    ok,
    detail: !hasAnalytics
      ? "spec asked for analytics + audit, but the change records neither (no trackEvent / recordAudit)"
      : durable
        ? "spec asked for analytics + audit only, but the change also writes a durable entity (triple-write)"
        : "spec asked for analytics + audit; the change records them",
  };
}

const GUARDED = /if\s+not\s+exists|if\s+exists/i;
const DESTRUCTIVE = /drop\s+(table|column|index)|delete\s+from|truncate\s+/i;

function checkReversibility(expected: string, files: string[], text: string): ConformanceFinding {
  const migrationFiles = files.filter((f) => /\.sql$/.test(f) || /migrations\//.test(f));
  const hasMigration = migrationFiles.length > 0;
  const hasDestructive = DESTRUCTIVE.test(text);

  if (expected === "guarded") {
    // Every migration must be idempotent-guarded, and no unguarded destructive op.
    const guarded = !hasMigration || GUARDED.test(text);
    const ok = guarded && !(hasDestructive && !GUARDED.test(text));
    return {
      requirement: "reversibility",
      expected,
      ok,
      detail: ok
        ? "spec asked for a migration-guarded change; the migration is idempotent"
        : "spec asked for a migration-guarded change, but a migration lacks IF NOT EXISTS / IF EXISTS guards",
    };
  }
  if (expected === "irreversible") {
    // Declared irreversible: allowed, but ALWAYS surfaced so a human signs off.
    return {
      requirement: "reversibility",
      expected,
      ok: true,
      detail: "spec declared this irreversible; it needs explicit human sign-off before merge",
    };
  }
  // "reversible" (default): a schema change or destructive op contradicts it.
  const ok = !hasMigration && !hasDestructive;
  return {
    requirement: "reversibility",
    expected,
    ok,
    detail: ok
      ? "spec said fully reversible; the change adds no migration or destructive operation"
      : "spec said fully reversible, but the change adds a migration or a destructive operation",
  };
}

/**
 * Measure a diff against a frozen spec. Returns one finding per spec dimension
 * present in the answers; `conforms` is true when all are satisfied.
 */
export function checkConformance(spec: FrozenSpec, diff: string): ConformanceResult {
  const files = changedFiles(diff);
  const text = addedText(diff);
  const findings: ConformanceFinding[] = [];

  if ("tests" in spec.answers) findings.push(checkTests(spec.answers.tests, files));
  if ("data" in spec.answers) findings.push(checkData(spec.answers.data, files, text));
  if ("reversibility" in spec.answers)
    findings.push(checkReversibility(spec.answers.reversibility, files, text));

  return {
    specHash: spec.hash,
    conforms: findings.every((f) => f.ok),
    findings,
  };
}
