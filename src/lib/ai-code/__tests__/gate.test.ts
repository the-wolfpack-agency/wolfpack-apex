/**
 * Deterministic code gate: critical blocks, high escalates, medium/low allow
 * with notes, none allows clean. Pure + reproducible; the deciding rule is named.
 */
import { decideCodeGate } from "../gate";
import type { AiCodeFinding } from "../types";

const f = (severity: AiCodeFinding["severity"]): AiCodeFinding => ({
  file: "x", line: 1, klass: "k", severity, cwe: null, title: "t", detail: "d", evidence: {},
});

test("critical blocks the merge", () => {
  const v = decideCodeGate([f("low"), f("critical")]);
  expect(v).toMatchObject({ outcome: "block", highestSeverity: "critical", ruleId: "C-CRITICAL-BLOCK" });
});

test("high escalates to human review", () => {
  expect(decideCodeGate([f("medium"), f("high")])).toMatchObject({ outcome: "escalate", highestSeverity: "high" });
});

test("medium/low are allowed with notes", () => {
  expect(decideCodeGate([f("medium"), f("low")])).toMatchObject({ outcome: "allow", highestSeverity: "medium" });
});

test("no findings -> clean allow", () => {
  expect(decideCodeGate([])).toMatchObject({ outcome: "allow", highestSeverity: "none", ruleId: "C-CLEAN-ALLOW" });
});

test("the verdict is deterministic (same input, same output)", () => {
  const findings = [f("high"), f("medium")];
  expect(decideCodeGate(findings)).toEqual(decideCodeGate(findings));
});
