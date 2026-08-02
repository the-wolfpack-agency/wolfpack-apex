/**
 * The safety controls must not be able to tell whose model it is.
 *
 * THE ARGUMENT
 *
 * A client can plug in their own LLM. The reason that is safe — and the reason
 * it is worth doing at all — is that a client model runs under the same gate,
 * the same containment budget, the same behaviour eval and the same audit trail
 * as a Wolfpack one.
 *
 * The moment any of those branches on origin, the claim collapses in one of two
 * directions, and both are bad:
 *
 *   - "client models get an EXTRA check" means our own models are the ones
 *     running unchecked, and we would be selling assurance we do not apply to
 *     ourselves.
 *   - "wolfpack models SKIP a check" is the same sentence with the quiet part
 *     out loud.
 *
 * Letting a stranger's model through the same pipe is the strongest way to keep
 * the controls honest, because a control that only works on models we built is
 * not a control — it is a property of those models.
 *
 * WHAT THIS CHECKS
 *
 * The control modules must not reference model origin at all. Not to weaken a
 * check, not to strengthen one, not to log it differently. If a control needs
 * to know, that is a design conversation, not an import.
 *
 * Analytics and reporting are explicitly NOT controls, and are expected to know:
 * a cost figure has to say which prices were declared rather than verified.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(__dirname, "..", "..", "..", "..");

/**
 * Modules that decide whether an agent may act, how much it may spend, or
 * whether it behaved. These are the ones that must stay blind.
 */
const CONTROL_PATHS = [
  "lib/ogiam",
  "lib/containment",
  "lib/agents/evals",
  "lib/platform-scan/browser/gate.ts",
  "lib/platform-scan/pentest/guard.ts",
];

/** Ways a module could learn whose model it is. */
const ORIGIN_SIGNALS = [/\bisClientModel\b/, /\borigin\s*===\s*["']client["']/, /\bpriceDeclaredByClient\b/, /\bModelOrigin\b/];

/**
 * Control modules allowed to reference origin, with the reason.
 *
 * Empty, and it should stay that way. An entry here is a claim that a control
 * legitimately treats two models differently, which needs an argument, not a
 * line in a list.
 */
const ALLOWED: Readonly<Record<string, string>> = {};

function walk(target: string, prefix: string, out: string[] = []): string[] {
  const abs = join(SRC, target);
  if (!statSync(abs, { throwIfNoEntry: false })) return out;
  if (statSync(abs).isFile()) {
    out.push(prefix);
    return out;
  }
  for (const entry of readdirSync(abs)) {
    if (entry === "__tests__" || entry.startsWith(".")) continue;
    const childRel = `${target}/${entry}`;
    const childPrefix = `${prefix}/${entry}`;
    if (statSync(join(SRC, childRel)).isDirectory()) walk(childRel, childPrefix, out);
    else if (entry.endsWith(".ts")) out.push(childPrefix);
  }
  return out;
}

describe("the controls cannot tell whose model it is", () => {
  const files = CONTROL_PATHS.flatMap((p) => walk(p, p));

  it("finds the control modules, so a broken walk cannot pass by finding nothing", () => {
    // A scanner that silently matches zero files reports success forever.
    expect(files.length).toBeGreaterThan(15);
  });

  it("no control module references model origin", () => {
    const offenders: string[] = [];
    for (const rel of files) {
      if (rel in ALLOWED) continue;
      const source = readFileSync(join(SRC, rel), "utf-8");
      for (const signal of ORIGIN_SIGNALS) {
        if (signal.test(source)) {
          offenders.push(`${rel} (matched ${signal})`);
          break;
        }
      }
    }
    expect({
      hint: "A control that knows whose model it is can treat them differently, and then 'we govern client models exactly like ours' stops being true. If a control genuinely needs this, that is a design decision, not an import.",
      offenders,
    }).toEqual({ hint: expect.any(String), offenders: [] });
  });

  it("has no stale allow-list entry", () => {
    const stale = Object.keys(ALLOWED).filter((rel) => {
      const source = readFileSync(join(SRC, rel), "utf-8");
      return !ORIGIN_SIGNALS.some((s) => s.test(source));
    });
    expect({ hint: "No longer references origin. Remove it from ALLOWED.", stale }).toEqual({
      hint: expect.any(String),
      stale: [],
    });
  });

  it("catches the patterns it claims to", () => {
    // A guardrail nobody has watched fire is a guardrail nobody knows works.
    const samples = [
      'if (isClientModel(spec)) skipBudgetCheck();',
      'if (spec.origin === "client") requireExtraApproval();',
      "const declared = spec.priceDeclaredByClient;",
    ];
    for (const sample of samples) {
      expect(ORIGIN_SIGNALS.some((s) => s.test(sample))).toBe(true);
    }
  });

  it("does not fire on ordinary control code", () => {
    // Noise is how a guardrail gets switched off.
    for (const sample of ["const client = await pool.connect();", "// the client asked for this", "clientPin"]) {
      expect(ORIGIN_SIGNALS.some((s) => s.test(sample))).toBe(false);
    }
  });
});

describe("reporting is allowed to know, because honesty requires it", () => {
  it("the cost surface can distinguish a declared price from a verified one", () => {
    // The counterpart to the rule above. A control must not know; a REPORT
    // must, or it totals a number we verified with one a client typed and
    // presents both as ours.
    const insights = readFileSync(join(SRC, "lib/ai/models/insights.ts"), "utf-8");
    expect(insights).toContain("estimated");
    // Not asserting it references origin YET — the surface predates client
    // models. This pins the intent so the follow-up is visible.
    expect(CONTROL_PATHS).not.toContain("lib/ai/models");
  });
});
