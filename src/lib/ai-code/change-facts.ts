/**
 * Deterministic facts about a change, extracted from its unified diff.
 *
 * These are the PRODUCERS for the OGIAM engineering invariants: the policy
 * registry (src/lib/ogiam/policy.ts) already decides what to do with a fact like
 * "a runtime dependency was added"; this computes that fact from the actual diff
 * so the invariant fires on real changes rather than test inputs. The rule lives
 * in ONE place (the registry); this only measures.
 *
 * Pure: no IO, no clock. A diff in, facts out, same every time.
 */
import { decide } from "@/lib/ogiam/policy";
import type { OgiamDecision } from "@/lib/ogiam/types";

export interface ChangeFacts {
  /** Net new RUNTIME dependencies (added minus removed under "dependencies").
   *  devDependencies are excluded - they do not ship. */
  dependencyDelta: number;
  addedDependencies: string[];
  removedDependencies: string[];
}

/** A package.json dependency entry line, e.g.  "left-pad": "^1.3.0",  */
const DEP_ENTRY = /^\s*"([^"]+)"\s*:\s*"[^"]*"\s*,?\s*$/;

function stripDiffMarker(line: string): { mark: " " | "+" | "-"; body: string } | null {
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@") || line.startsWith("diff ")) return null;
  const mark = line[0];
  if (mark === "+" || mark === "-" || mark === " ") return { mark, body: line.slice(1) };
  return null; // "\ No newline at end of file" etc.
}

/**
 * Extract dependency changes from a unified diff. Tracks which JSON section a
 * line is in so only the runtime "dependencies" object is counted. A change
 * outside package.json contributes nothing.
 */
export function dependencyFactsFromDiff(diff: string): ChangeFacts {
  const added: string[] = [];
  const removed: string[] = [];
  let inPackageJson = false;
  let section: "deps" | "other" | "none" = "none";

  for (const raw of diff.split("\n")) {
    // File boundaries switch which file we're reading.
    const fileHeader = /^\+\+\+ b\/(.+)$/.exec(raw) ?? /^diff --git a\/\S+ b\/(.+)$/.exec(raw);
    if (fileHeader) {
      inPackageJson = /(^|\/)package\.json$/.test(fileHeader[1].trim());
      section = "none";
      continue;
    }
    if (!inPackageJson) continue;

    const parsed = stripDiffMarker(raw);
    if (!parsed) continue;
    const trimmed = parsed.body.trim();

    // Section tracking: a header sets the section; a lone closing brace leaves it.
    if (/^"dependencies"\s*:/.test(trimmed)) { section = "deps"; continue; }
    if (/^"(dev|peer|optional)Dependencies"\s*:/.test(trimmed)) { section = "other"; continue; }
    if (trimmed === "}" || trimmed === "},") { section = "none"; continue; }

    if (section !== "deps") continue;
    const m = DEP_ENTRY.exec(parsed.body);
    if (!m) continue;
    if (parsed.mark === "+") added.push(m[1]);
    else if (parsed.mark === "-") removed.push(m[1]);
  }

  return { dependencyDelta: added.length - removed.length, addedDependencies: added, removedDependencies: removed };
}

export interface ChangeInvariantInput {
  /** Whether CI has fully passed (known at the merge/handoff point, not authoring). */
  ciComplete?: boolean;
  /** How many times the change would deploy (known at the deploy point). */
  deploymentCount?: number;
}

/**
 * Run a change's decidable facts through the OGIAM policy registry. Reuses
 * decide() so the RULES are not duplicated here - this assembles the signals and
 * asks the one reference monitor. Returns the decision plus the measured facts so
 * a caller can both enforce and explain.
 */
export function evaluateChangeInvariants(
  diff: string,
  input: ChangeInvariantInput = {},
): { decision: OgiamDecision; facts: ChangeFacts } {
  const facts = dependencyFactsFromDiff(diff);
  const decision = decide(
    {
      tool: "apply_change",
      capability: "code.write",
      isMutation: true,
      surface: "ai-code/factory",
      paramsHash: "n/a",
      signals: {
        dependencyDelta: facts.dependencyDelta,
        ...(input.ciComplete !== undefined ? { ciComplete: input.ciComplete } : {}),
        ...(input.deploymentCount !== undefined ? { deploymentCount: input.deploymentCount } : {}),
      },
    },
    { mode: "enforce" },
  );
  return { decision, facts };
}
