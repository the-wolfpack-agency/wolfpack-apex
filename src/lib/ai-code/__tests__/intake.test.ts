/**
 * Intake engine: fixed multiple-choice resolution, deferred/batched open
 * questions, off-menu answers rejected, and a stable order-independent spec hash.
 */
import { resolveIntake, freezeSpec, canonicalSpec, DEFAULT_SPEC_QUESTIONS, specDirectives, withSpecDirectives, AUTHOR_CONSISTENCY_DIRECTIVE, type SpecQuestion } from "../intake";

const QS: SpecQuestion[] = [
  { id: "a", prompt: "A?", options: [{ id: "x", label: "X" }, { id: "y", label: "Y" }], default: "x" },
  { id: "b", prompt: "B?", options: [{ id: "p", label: "P" }, { id: "q", label: "Q" }], default: "p" },
];

describe("resolveIntake", () => {
  it("defaults every unanswered question and returns them all as open (nothing blocks up front)", () => {
    const r = resolveIntake(QS, {});
    expect(r.answers).toEqual({ a: "x", b: "p" });
    expect(r.open.map((q) => q.id)).toEqual(["a", "b"]);
  });

  it("uses an explicit answer and drops that question from the batch", () => {
    const r = resolveIntake(QS, { a: "y" });
    expect(r.answers).toEqual({ a: "y", b: "p" });
    expect(r.open.map((q) => q.id)).toEqual(["b"]); // only the defaulted one needs confirming
  });

  it("rejects an off-menu answer (the option space is fixed)", () => {
    expect(() => resolveIntake(QS, { a: "z" })).toThrow(/unknown option/);
    expect(() => resolveIntake(QS, { nope: "x" })).toThrow(/unknown spec question/);
  });

  it("the default catalog resolves with no answers", () => {
    const r = resolveIntake(DEFAULT_SPEC_QUESTIONS, {});
    expect(r.answers).toEqual({ tests: "all", data: "analytics", reversibility: "reversible", error_handling: "throw", input_strictness: "strict" });
    expect(r.open).toHaveLength(5);
  });
});

describe("freezeSpec", () => {
  it("produces a stable, order-independent hash", () => {
    const a = freezeSpec("build X", { a: "x", b: "p" }, "2026-09-16T00:00:00Z");
    const b = freezeSpec("build X", { b: "p", a: "x" }, "2026-09-16T00:00:00Z");
    expect(a.hash).toBe(b.hash);
    expect(a.hash).toMatch(/^spec_[0-9a-f]{24}$/);
  });

  it("changes the hash when the prompt or an answer changes", () => {
    const base = freezeSpec("build X", { a: "x" }, "t").hash;
    expect(freezeSpec("build Y", { a: "x" }, "t").hash).not.toBe(base);
    expect(freezeSpec("build X", { a: "y" }, "t").hash).not.toBe(base);
  });

  it("canonicalSpec is whitespace-normalized on the prompt", () => {
    expect(canonicalSpec("  build X  ", { a: "x" })).toBe(canonicalSpec("build X", { a: "x" }));
  });
});

describe("specDirectives (the frozen spec governs authoring)", () => {
  it("emits the directive for each resolved answer's chosen option", () => {
    const { answers } = resolveIntake(DEFAULT_SPEC_QUESTIONS, { error_handling: "throw", input_strictness: "strict" });
    const ds = specDirectives(DEFAULT_SPEC_QUESTIONS, answers);
    expect(ds.some((d) => /THROW an error/i.test(d))).toBe(true);
    expect(ds.some((d) => /STRICTLY/i.test(d))).toBe(true);
  });

  it("uses defaults (throw + strict) when the ambiguity questions are unanswered", () => {
    const { answers } = resolveIntake(DEFAULT_SPEC_QUESTIONS, { tests: "all" });
    expect(answers.error_handling).toBe("throw");
    expect(answers.input_strictness).toBe("strict");
    const ds = specDirectives(DEFAULT_SPEC_QUESTIONS, answers);
    expect(ds.some((d) => /THROW/i.test(d))).toBe(true);
  });

  it("emits nothing for spec-record-only questions (no directive)", () => {
    // tests/data/reversibility carry no directive -> no author guidance from them.
    const ds = specDirectives(DEFAULT_SPEC_QUESTIONS, { tests: "all", data: "durable", reversibility: "irreversible" });
    expect(ds).toEqual([]);
  });

  it("lenient/best-effort options carry their own directives", () => {
    const ds = specDirectives(DEFAULT_SPEC_QUESTIONS, { error_handling: "best_effort", input_strictness: "lenient" });
    expect(ds.some((d) => /best-effort/i.test(d))).toBe(true);
    expect(ds.some((d) => /LENIENTLY/i.test(d))).toBe(true);
  });
});

describe("withSpecDirectives", () => {
  it("prepends the consistency directive + the resolved directives above the prompt", () => {
    const out = withSpecDirectives("Build parseRange.", ["On invalid input, THROW."]);
    expect(out).toMatch(/Spec directives \(follow exactly\):/);
    expect(out).toContain(AUTHOR_CONSISTENCY_DIRECTIVE);
    expect(out).toMatch(/On invalid input, THROW\./);
    expect(out.indexOf("Spec directives")).toBeLessThan(out.indexOf("Build parseRange.")); // directives come first
  });

  it("always includes the consistency directive even with no spec directives", () => {
    const out = withSpecDirectives("Build X.", []);
    expect(out).toContain(AUTHOR_CONSISTENCY_DIRECTIVE);
  });
});
