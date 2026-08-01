/**
 * The prompt registry: prompts as versioned, reviewable artifacts.
 *
 * WHY
 *
 * Fifteen files in src/lib currently build a system prompt inline. That has
 * three costs. A change to one is invisible in review — it reads as a string
 * edit. A regression cannot be bisected, because there is no previous version
 * to point at. And nothing can be evaluated, because an eval needs a stable
 * identifier for the thing it is scoring.
 *
 * The fix is the same one the acceptance criteria applied to requirements: stop
 * treating the important part as prose. A prompt gets an id, a version, a typed
 * input, and an explicitly stated scope.
 *
 * SCOPE IS NOT DECORATION
 *
 * Anthropic's write-up of their cybersecurity-eval incidents names ambiguous
 * scope as a direct contributing cause: models attacked real infrastructure
 * partly because the prompt did not say which systems were in and out of
 * bounds, and the model reasoned that what it found must be in the exercise.
 * So `scope` is a required field here, not an optional note. A prompt that
 * cannot say what it is allowed to touch does not get registered.
 *
 * Pure: no model call, no network, no clock.
 */

/** What a prompt is permitted to act on, stated rather than implied. */
export interface PromptScope {
  /** Systems, data or surfaces this prompt may act on. */
  inScope: string[];
  /**
   * Explicitly out of bounds. Non-empty by requirement: "everything not listed
   * above" is exactly the ambiguity that let a model treat live infrastructure
   * as part of an exercise.
   */
  outOfScope: string[];
}

export interface PromptDefinition<Input = Record<string, never>> {
  /** Stable across versions. Evals and analytics key on this. */
  id: string;
  /** Bumped on every content change. Old versions stay addressable. */
  version: number;
  /** One line: what this prompt is for. */
  purpose: string;
  scope: PromptScope;
  /** Names of the inputs render() requires. Checked before rendering. */
  inputs: readonly string[];
  /** Build the prompt text. Must be deterministic for a given input. */
  render: (input: Input) => string;
}

export class PromptError extends Error {
  constructor(
    message: string,
    public readonly promptId: string,
  ) {
    super(message);
    this.name = "PromptError";
  }
}

const registry = new Map<string, PromptDefinition<never>>();

/**
 * Register a prompt. Refuses anything that cannot be reviewed or evaluated:
 * no id, no scope, or a scope that does not say what is out of bounds.
 */
export function definePrompt<Input>(def: PromptDefinition<Input>): PromptDefinition<Input> {
  if (!def.id.trim()) throw new PromptError("a prompt needs an id", def.id);
  if (!Number.isInteger(def.version) || def.version < 1) {
    throw new PromptError("version must be an integer >= 1", def.id);
  }
  if (!def.purpose.trim()) throw new PromptError("a prompt needs a purpose", def.id);
  if (def.scope.inScope.length === 0) throw new PromptError("scope.inScope must not be empty", def.id);
  if (def.scope.outOfScope.length === 0) {
    // The Anthropic lesson, enforced. "Everything else" is not a boundary.
    throw new PromptError("scope.outOfScope must not be empty — state what this prompt may NOT touch", def.id);
  }
  const key = `${def.id}@${def.version}`;
  if (registry.has(key)) throw new PromptError(`${key} is already registered`, def.id);
  registry.set(key, def as unknown as PromptDefinition<never>);
  return def;
}

/** Look up an exact version. Old versions stay addressable so a regression can
 *  be bisected against the prompt that produced it. */
export function getPrompt(id: string, version: number): PromptDefinition<never> | null {
  return registry.get(`${id}@${version}`) ?? null;
}

/** The newest registered version of a prompt. */
export function latestPrompt(id: string): PromptDefinition<never> | null {
  const versions = [...registry.values()].filter((p) => p.id === id);
  if (versions.length === 0) return null;
  return versions.reduce((a, b) => (b.version > a.version ? b : a));
}

/**
 * Render a prompt, refusing when a declared input is missing.
 *
 * A missing input silently becoming "undefined" inside a system prompt is how
 * an agent ends up reasoning from a sentence nobody wrote.
 */
export function renderPrompt<Input extends Record<string, unknown>>(
  def: PromptDefinition<Input>,
  input: Input,
): string {
  const missing = def.inputs.filter((name) => input[name] === undefined || input[name] === null);
  if (missing.length > 0) {
    throw new PromptError(`missing required input(s): ${missing.join(", ")}`, def.id);
  }
  const body = def.render(input);
  // The scope is appended by the registry, not written by each author, so it
  // cannot be forgotten and reads identically in every prompt.
  return [
    body.trim(),
    "",
    "## Scope",
    "",
    "In scope, and only these:",
    ...def.scope.inScope.map((s) => `- ${s}`),
    "",
    "Out of scope. Do not act on these, and do not treat anything you encounter",
    "as in scope merely because you can reach it:",
    ...def.scope.outOfScope.map((s) => `- ${s}`),
  ].join("\n");
}

/** Everything registered, for the coverage guardrail and the admin surface. */
export function allPrompts(): PromptDefinition<never>[] {
  return [...registry.values()].sort((a, b) => a.id.localeCompare(b.id) || a.version - b.version);
}

/** Test seam: the registry is module state, and a suite that registers
 *  fixtures must not leak them into another suite. */
export function __resetRegistryForTests(): void {
  registry.clear();
}
