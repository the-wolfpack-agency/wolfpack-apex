/**
 * The registry's job is to refuse prompts that cannot be reviewed, bisected or
 * evaluated. Most of these tests are refusals for that reason.
 *
 * The scope rule carries the most weight. Anthropic's cybersecurity-eval
 * write-up names ambiguous scope as a contributing cause of models attacking
 * real infrastructure: the prompt did not say what was out of bounds, so the
 * model treated what it could reach as part of the exercise. "Everything else"
 * is not a boundary, and this refuses to register a prompt that offers one.
 */
import { definePrompt, renderPrompt, getPrompt, latestPrompt, allPrompts, PromptError, __resetRegistryForTests } from "../registry";

const scope = { inScope: ["the brief under edit"], outOfScope: ["client production data"] };

beforeEach(() => __resetRegistryForTests());

describe("definePrompt", () => {
  it("registers a well-formed prompt", () => {
    const p = definePrompt({ id: "brief.summarize", version: 1, purpose: "summarize a brief", scope, inputs: ["brief"], render: () => "x" });
    expect(getPrompt("brief.summarize", 1)).toBe(p);
  });

  it("refuses a prompt that does not say what it may NOT touch", () => {
    // The rule the incidents argue for. A model that can reach something and
    // has not been told it is out of bounds will reason that it is in bounds.
    expect(() =>
      definePrompt({ id: "x", version: 1, purpose: "p", scope: { inScope: ["a"], outOfScope: [] }, inputs: [], render: () => "x" }),
    ).toThrow(/outOfScope/);
  });

  it("refuses an empty in-scope list, an empty purpose and an empty id", () => {
    const base = { version: 1, purpose: "p", scope, inputs: [], render: () => "x" };
    expect(() => definePrompt({ ...base, id: "y", scope: { inScope: [], outOfScope: ["b"] } })).toThrow(/inScope/);
    expect(() => definePrompt({ ...base, id: "y", purpose: "  " })).toThrow(/purpose/);
    expect(() => definePrompt({ ...base, id: "   " })).toThrow(/id/);
  });

  it("refuses a version that is not a positive integer", () => {
    const base = { id: "z", purpose: "p", scope, inputs: [], render: () => "x" };
    for (const version of [0, -1, 1.5, Number.NaN]) {
      expect(() => definePrompt({ ...base, version })).toThrow(/version/);
    }
  });

  it("refuses to overwrite an existing id@version", () => {
    // Silently replacing a version would break the one thing versioning buys:
    // being able to point at the exact prompt that produced a bad output.
    const def = { id: "dup", version: 1, purpose: "p", scope, inputs: [], render: () => "x" };
    definePrompt(def);
    expect(() => definePrompt(def)).toThrow(/already registered/);
  });

  it("carries the offending prompt id on the error", () => {
    try {
      definePrompt({ id: "named", version: 0, purpose: "p", scope, inputs: [], render: () => "x" });
      throw new Error("expected a throw");
    } catch (err) {
      expect((err as PromptError).promptId).toBe("named");
    }
  });
});

describe("versions", () => {
  it("keeps old versions addressable so a regression can be bisected", () => {
    const v1 = definePrompt({ id: "v", version: 1, purpose: "p", scope, inputs: [], render: () => "first" });
    const v2 = definePrompt({ id: "v", version: 2, purpose: "p", scope, inputs: [], render: () => "second" });
    // Identity, not a re-render: the stored definition must be the one that was
    // registered, which is what makes "the prompt that produced this output"
    // answerable. (getPrompt erases the input type by design — the registry
    // holds many prompt shapes — so callers render through their own typed
    // definition, as the assertion below does.)
    expect(getPrompt("v", 1)).toBe(v1);
    expect(getPrompt("v", 2)).toBe(v2);
    expect(v1.render({})).toBe("first");
    expect(latestPrompt("v")?.version).toBe(2);
  });

  it("returns null for an unknown prompt rather than a default", () => {
    expect(getPrompt("nope", 1)).toBeNull();
    expect(latestPrompt("nope")).toBeNull();
  });
});

describe("renderPrompt", () => {
  const def = definePromptFixture();
  function definePromptFixture() {
    return {
      id: "greet",
      version: 1,
      purpose: "greet",
      scope: { inScope: ["the current workspace"], outOfScope: ["other workspaces", "production credentials"] },
      inputs: ["name"] as const,
      render: (i: { name: string }) => `Hello ${i.name}.`,
    };
  }

  it("renders the body and appends the scope in a fixed shape", () => {
    const out = renderPrompt(def, { name: "Dana" });
    expect(out).toContain("Hello Dana.");
    expect(out).toContain("- the current workspace");
    expect(out).toContain("- production credentials");
    // The wording that matters: reachability is not permission.
    expect(out).toMatch(/do not treat anything you encounter[\s\S]*because you can reach it/);
  });

  it("refuses to render with a missing input instead of interpolating undefined", () => {
    // "Hello undefined." is a sentence nobody wrote, and an agent will reason
    // from it as if someone had.
    expect(() => renderPrompt(def, {} as { name: string })).toThrow(/missing required input\(s\): name/);
    expect(() => renderPrompt(def, { name: null } as unknown as { name: string })).toThrow(/name/);
  });

  it("accepts an input that is falsy but present", () => {
    const d = { ...def, id: "falsy", inputs: ["count"] as const, render: (i: { count: number }) => `n=${i.count}` };
    expect(renderPrompt(d, { count: 0 })).toContain("n=0");
  });

  it("is deterministic for a given input", () => {
    expect(renderPrompt(def, { name: "Dana" })).toBe(renderPrompt(def, { name: "Dana" }));
  });
});

describe("allPrompts", () => {
  it("lists everything registered, ordered stably", () => {
    definePrompt({ id: "b", version: 1, purpose: "p", scope, inputs: [], render: () => "x" });
    definePrompt({ id: "a", version: 2, purpose: "p", scope, inputs: [], render: () => "x" });
    definePrompt({ id: "a", version: 1, purpose: "p", scope, inputs: [], render: () => "x" });
    expect(allPrompts().map((p) => `${p.id}@${p.version}`)).toEqual(["a@1", "a@2", "b@1"]);
  });
});
