/**
 * The migration-safety gate: a destructive or non-idempotent migration stops for
 * a human; an additive + idempotent one (or no migration) clears. Deterministic.
 */
import { migrationSafetyGate } from "@/lib/gates/migration-safety-gate";
import { runGate } from "@/lib/gates/run-gate";

const ctx = { workspaceId: "w1", actorId: "u1", policy: { frameworks: ["SOC2"], allowModelData: "none" as const } };
const migDiff = (sql: string) =>
  `diff --git a/src/db/migrations/030_x.sql b/src/db/migrations/030_x.sql\n--- /dev/null\n+++ b/src/db/migrations/030_x.sql\n@@ -0,0 +1,1 @@\n+${sql}\n`;

it("allow: an additive, idempotent migration", async () => {
  const r = await runGate(migrationSafetyGate, { diff: migDiff("CREATE TABLE IF NOT EXISTS t (id uuid);") }, ctx);
  expect(r.verdict).toBe("allow");
  expect(r.output?.migrationFiles).toContain("src/db/migrations/030_x.sql");
});

it("require_human: a destructive DROP", async () => {
  const r = await runGate(migrationSafetyGate, { diff: migDiff("DROP TABLE users;") }, ctx);
  expect(r.verdict).toBe("require_human");
  expect(r.output?.violations.map((v) => v.id)).toContain("destructive-drop");
  expect(r.reason).toMatch(/lose data|destructive/i);
});

it("require_human: a non-idempotent CREATE TABLE (no IF NOT EXISTS)", async () => {
  const r = await runGate(migrationSafetyGate, { diff: migDiff("CREATE TABLE t (id uuid);") }, ctx);
  expect(r.verdict).toBe("require_human");
  expect(r.output?.violations.map((v) => v.id)).toContain("non-idempotent-create-table");
});

it("allow: a change with no migration file at all", async () => {
  const r = await runGate(migrationSafetyGate, { diff: "diff --git a/src/x.ts b/src/x.ts\n+export const x = 1;\n" }, ctx);
  expect(r.verdict).toBe("allow");
  expect(r.output?.migrationFiles).toEqual([]);
});

it("does not flag SQL outside a migration file", async () => {
  const r = await runGate(migrationSafetyGate, { diff: "diff --git a/docs/notes.md b/docs/notes.md\n+DROP TABLE example;\n" }, ctx);
  expect(r.verdict).toBe("allow"); // not a migrations/*.sql file
});
