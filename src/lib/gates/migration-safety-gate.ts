/**
 * migration-safety gate - a DB migration checkpoint enforcing the two rules that
 * keep a production migration safe: IDEMPOTENT (re-runnable) and ADDITIVE (no
 * destructive drop that loses data). It reuses the same added-line diff parser as
 * the code detectors, scans only the migration SQL a change adds, and stops for a
 * human on a risky op - never silently applies a data-losing or non-idempotent
 * migration.
 *
 *   no migration change / clean additive+idempotent  -> allow
 *   destructive (DROP/TRUNCATE) or non-idempotent      -> require_human
 *
 * Deterministic: no model. Per the repo's own conventions (additive-only, guarded
 * with IF (NOT) EXISTS; no DROP COLUMN without a paired follow-up).
 */
import { parseAddedLines } from "@/lib/ai-code/detect";
import type { GateDefinition, GateResult, GateFinding } from "./types";

const MIGRATION_FILE = /migrations?\/.*\.sql$/i;

/** Risky migration ops, checked per added SQL line. */
const RISKS: { id: string; severity: GateFinding["severity"]; re: RegExp }[] = [
  { id: "destructive-drop", severity: "high", re: /\bDROP\s+(?:TABLE|COLUMN)\b/i },
  { id: "destructive-truncate", severity: "high", re: /\bTRUNCATE\b/i },
  { id: "non-idempotent-create-table", severity: "medium", re: /\bCREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS)/i },
  { id: "non-idempotent-add-column", severity: "medium", re: /\bADD\s+COLUMN\s+(?!IF\s+NOT\s+EXISTS)/i },
  { id: "non-idempotent-create-index", severity: "medium", re: /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?!IF\s+NOT\s+EXISTS)/i },
];

export interface MigrationSafetyInput {
  diff: string;
}

export interface MigrationSafetyOutput {
  migrationFiles: string[];
  violations: { id: string; file: string; line: number }[];
}

export const migrationSafetyGate: GateDefinition<MigrationSafetyInput, MigrationSafetyOutput> = {
  name: "migration-safety",
  entitlement: "secure_agent",
  purpose: "Screen a DB migration for the two production-safety rules - idempotent (re-runnable, guarded with IF (NOT) EXISTS) and additive (no destructive DROP/TRUNCATE that loses data) - and stop a risky one for a human.",
  async evaluate(input, ctx): Promise<GateResult<MigrationSafetyOutput>> {
    const added = parseAddedLines(input.diff).filter((a) => MIGRATION_FILE.test(a.file));
    const migrationFiles = [...new Set(added.map((a) => a.file))];
    const violations: MigrationSafetyOutput["violations"] = [];
    for (const a of added) {
      for (const r of RISKS) if (r.re.test(a.text)) violations.push({ id: r.id, file: a.file, line: a.line });
    }
    const output = { migrationFiles, violations };
    const dataSeen = `The added SQL in ${migrationFiles.length} migration file(s). No model invoked.`;
    const checks = ["idempotency (IF (NOT) EXISTS)", "additive-only (no DROP/TRUNCATE)"];

    if (migrationFiles.length === 0 || violations.length === 0) {
      const reason = migrationFiles.length === 0 ? "No migration change in this diff." : "Migration is additive and idempotent.";
      return {
        verdict: "allow",
        output,
        findings: [],
        reason,
        transparency: { checksRun: checks, dataSeen, modelInvoked: null, frameworksApplied: ctx.policy.frameworks, explanation: reason },
        audit: { gate: "migration-safety", verdict: "allow", ruleId: "GATE-migration-safety-clean", reason, workspaceId: ctx.workspaceId, actorId: ctx.actorId },
      };
    }

    const summary = [...new Set(violations.map((v) => v.id))].join(", ");
    const reason = `Risky migration op(s): ${summary}. A destructive or non-idempotent migration can lose data or fail a re-run, so it stops for a human to confirm it is intended and paired with a safe path.`;
    return {
      verdict: "require_human",
      output,
      findings: violations.map((v) => ({ id: v.id, severity: (RISKS.find((r) => r.id === v.id)?.severity ?? "medium"), detail: `${v.id} at ${v.file}:${v.line}` })),
      reason,
      transparency: { checksRun: checks, dataSeen, modelInvoked: null, frameworksApplied: ctx.policy.frameworks, explanation: reason },
      audit: { gate: "migration-safety", verdict: "require_human", ruleId: "GATE-migration-safety-risky", reason, workspaceId: ctx.workspaceId, actorId: ctx.actorId },
    };
  },
};
