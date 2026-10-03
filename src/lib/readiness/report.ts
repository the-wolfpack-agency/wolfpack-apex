/**
 * Production-readiness engine - pure report aggregation.
 *
 * One implementation for every tool (DRY): grade each criterion against the
 * tool's computed signals, then roll up ready/partial/gap counts and a 0..1
 * score, overall and per dimension. No I/O, no per-tool branching.
 */
import type {
  CriterionResult,
  ReadinessStatus,
  ToolReadinessReport,
  ToolSignals,
  ToolSpec,
} from "./types";

/** Half credit for partial so gap -> partial -> ready reads as real progress. */
function statusWeight(s: ReadinessStatus): number {
  return s === "ready" ? 1 : s === "partial" ? 0.5 : 0;
}

function scoreOf(results: { status: ReadinessStatus }[]): number {
  if (results.length === 0) return 0;
  const sum = results.reduce((n, r) => n + statusWeight(r.status), 0);
  return sum / results.length;
}

/** Grade one tool against already-collected signals. Pure. */
export function gradeTool(spec: ToolSpec, signals: ToolSignals): ToolReadinessReport {
  const results: CriterionResult[] = spec.criteria.map((c) => ({
    id: c.id,
    dimension: c.dimension,
    title: c.title,
    rationale: c.rationale,
    kind: c.kind,
    status: c.status(signals),
    evidence: c.evidence(signals),
  }));

  const count = (s: ReadinessStatus) => results.filter((r) => r.status === s).length;

  const byDimension: ToolReadinessReport["byDimension"] = {};
  for (const r of results) {
    const d = (byDimension[r.dimension] ??= { ready: 0, partial: 0, gap: 0, score: 0 });
    d[r.status] += 1;
  }
  for (const d of Object.keys(byDimension)) {
    byDimension[d].score = scoreOf(results.filter((r) => r.dimension === d));
  }

  return {
    toolId: spec.id,
    label: spec.label,
    surface: spec.surface,
    results,
    ready: count("ready"),
    partial: count("partial"),
    gap: count("gap"),
    total: results.length,
    score: scoreOf(results),
    byDimension,
  };
}

/** Collect signals (scans the repo via the reader) then grade. */
export function reportTool(spec: ToolSpec, reader: import("./types").RepoReader): ToolReadinessReport {
  return gradeTool(spec, spec.collectSignals(reader));
}

/** Score as a whole-number percentage, for display. */
export function scorePct(score: number): number {
  return Math.round(score * 100);
}
