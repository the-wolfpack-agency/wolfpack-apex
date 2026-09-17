/**
 * Spec-conformance oracle: measure a diff against the frozen spec, deterministically.
 */
import { checkConformance } from "../conformance";
import { freezeSpec } from "../intake";

const NOW = "2026-09-17T00:00:00.000Z";
const spec = (answers: Record<string, string>) => freezeSpec("task", answers, NOW);

/** A diff that adds `lines` to `path`. Combinable by concatenation. */
function fileDiff(path: string, lines: string[]): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,1 +1,${lines.length + 1} @@`,
    " existing",
    ...lines.map((l) => `+${l}`),
    "",
  ].join("\n");
}
const combine = (...d: string[]) => d.join("\n");

const UNIT = fileDiff("src/lib/thing/__tests__/thing.test.ts", ["it('works', () => {});"]);
const CONTRACT = fileDiff("src/app/api/thing/__tests__/route.test.ts", ["it('200', () => {});"]);
const E2E = fileDiff("tests/e2e/thing.spec.ts", ["test('flow', async () => {});"]);
const CODE = fileDiff("src/lib/thing/thing.ts", ["export const x = 1;"]);

function tests(diff: string, expected: string) {
  return checkConformance(spec({ tests: expected }), diff).findings.find((f) => f.requirement === "tests")!;
}
function data(diff: string, expected: string) {
  return checkConformance(spec({ data: expected }), diff).findings.find((f) => f.requirement === "data")!;
}
function rev(diff: string, expected: string) {
  return checkConformance(spec({ reversibility: expected }), diff).findings.find((f) => f.requirement === "reversibility")!;
}

describe("conformance: tests", () => {
  it("all: needs unit + contract + e2e", () => {
    expect(tests(combine(UNIT, CONTRACT, E2E), "all").ok).toBe(true);
    expect(tests(combine(UNIT, CONTRACT), "all").ok).toBe(false);
    expect(tests(combine(UNIT), "all").ok).toBe(false);
  });
  it("contract: needs unit + contract", () => {
    expect(tests(combine(UNIT, CONTRACT), "contract").ok).toBe(true);
    expect(tests(combine(UNIT), "contract").ok).toBe(false);
  });
  it("unit: needs at least one test", () => {
    expect(tests(UNIT, "unit").ok).toBe(true);
    expect(tests(CODE, "unit").ok).toBe(false);
  });
});

describe("conformance: data", () => {
  it("durable: requires triple-write", () => {
    expect(data(fileDiff("src/lib/x.ts", ["await tripleWrite(doc);"]), "durable").ok).toBe(true);
    expect(data(CODE, "durable").ok).toBe(false);
  });
  it("none: rejects added persistence", () => {
    expect(data(fileDiff("src/lib/x.ts", ["await query('INSERT INTO t VALUES (1)');"]), "none").ok).toBe(false);
    expect(data(fileDiff("db/migrations/900_x.sql", ["CREATE TABLE t ();"]), "none").ok).toBe(false);
    expect(data(CODE, "none").ok).toBe(true);
  });
  it("analytics: requires trackEvent/audit, and not a durable write", () => {
    expect(data(fileDiff("src/lib/x.ts", ["trackEvent('x.done', u, r, {});"]), "analytics").ok).toBe(true);
    expect(data(fileDiff("src/lib/x.ts", ["await tripleWrite(doc);"]), "analytics").ok).toBe(false);
    expect(data(CODE, "analytics").ok).toBe(false);
  });
});

describe("conformance: reversibility", () => {
  it("guarded: a migration must be idempotent", () => {
    expect(rev(fileDiff("db/migrations/900_x.sql", ["CREATE TABLE IF NOT EXISTS t ();"]), "guarded").ok).toBe(true);
    expect(rev(fileDiff("db/migrations/900_x.sql", ["CREATE TABLE t ();"]), "guarded").ok).toBe(false);
  });
  it("reversible: a migration or destructive op is a deviation", () => {
    expect(rev(CODE, "reversible").ok).toBe(true);
    expect(rev(fileDiff("db/migrations/900_x.sql", ["CREATE TABLE t ();"]), "reversible").ok).toBe(false);
    expect(rev(fileDiff("src/lib/x.ts", ["await query('DROP TABLE t');"]), "reversible").ok).toBe(false);
  });
  it("irreversible: allowed but always flagged for sign-off", () => {
    const f = rev(fileDiff("db/migrations/900_x.sql", ["DROP TABLE t;"]), "irreversible");
    expect(f.ok).toBe(true);
    expect(f.detail).toMatch(/sign-off/i);
  });
});

describe("conformance: overall", () => {
  it("a fully conformant change conforms, and carries the spec hash", () => {
    const s = spec({ tests: "all", data: "analytics", reversibility: "reversible" });
    const diff = combine(UNIT, CONTRACT, E2E, fileDiff("src/lib/x.ts", ["trackEvent('x.done', u, r, {});"]));
    const res = checkConformance(s, diff);
    expect(res.conforms).toBe(true);
    expect(res.findings).toHaveLength(3);
    expect(res.specHash).toBe(s.hash);
  });

  it("a change that skips required tests does NOT conform, with the deviation stated", () => {
    const s = spec({ tests: "all", data: "analytics", reversibility: "reversible" });
    const diff = combine(UNIT, fileDiff("src/lib/x.ts", ["trackEvent('x.done', u, r, {});"]));
    const res = checkConformance(s, diff);
    expect(res.conforms).toBe(false);
    const t = res.findings.find((f) => f.requirement === "tests")!;
    expect(t.ok).toBe(false);
    expect(t.detail).toMatch(/unit, contract and end-to-end/i);
  });

  it("only reports dimensions the spec names", () => {
    const res = checkConformance(spec({ tests: "unit" }), UNIT);
    expect(res.findings.map((f) => f.requirement)).toEqual(["tests"]);
  });
});
