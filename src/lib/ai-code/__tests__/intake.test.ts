/**
 * Intake engine: fixed multiple-choice resolution, deferred/batched open
 * questions, off-menu answers rejected, and a stable order-independent spec hash.
 */
import { resolveIntake, freezeSpec, canonicalSpec, DEFAULT_SPEC_QUESTIONS, type SpecQuestion } from "../intake";

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
    expect(r.answers).toEqual({ tests: "all", data: "analytics", reversibility: "reversible" });
    expect(r.open).toHaveLength(3);
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
