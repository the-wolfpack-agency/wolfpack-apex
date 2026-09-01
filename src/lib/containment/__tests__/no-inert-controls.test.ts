/**
 * A safety control with no caller is a comment that costs money to maintain.
 *
 * THE PATTERN THIS AUTOMATES
 *
 * This has now been found by hand five times, one at a time, always the same
 * way — someone noticed while working nearby:
 *
 *   unexplained()            shipped with no caller; nothing produced its
 *                            declaredHosts argument until #223.
 *   behavior-eval            shipped with rules and no caller until #226.
 *   network observations     shipped with no caller until #223.
 *   session-retro            shipped with no caller; the handoff script had
 *                            hand-copied its taxonomy instead (#229).
 *   runDeviceMatrix          still has no caller outside tests.
 *
 * Every one of those looked like coverage. Tests passed, the module was
 * thorough, and it protected nothing, because nothing ran it. That is worse
 * than an absent control: an absent one is a known gap, and this is a gap
 * everyone believes is closed.
 *
 * Finding it by noticing does not scale. This finds it on every build.
 *
 * WHY IT IS SCOPED TO CONTROL MODULES
 *
 * Run over all of src/lib it would flag hundreds of legitimately-unused
 * helpers and get switched off within a week — the way every noisy guardrail
 * dies. These directories are the ones whose whole purpose is to stop
 * something bad, so "nothing calls it" is a much stronger signal there.
 *
 * A test does NOT count as a caller. That is the entire point: being tested is
 * exactly what these modules all were.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const LIB = join(__dirname, "..", "..");
const SRC = join(LIB, "..");

/** Directories whose exports exist to prevent something. */
const CONTROL_DIRS = [
  "containment",
  "agents/evals",
  "platform-scan/anomaly",
  "platform-scan/compliance",
  "platform-scan/authorization",
  "platform-scan/pentest",
  "ogiam",
];

/**
 * Exports that are deliberately not called from production yet, with the
 * reason. An entry is DEBT with a date, not an exemption — and the stale check
 * below deletes it the moment it gains a caller, so it cannot rot into
 * permanent permission.
 */
const KNOWN_INERT: Readonly<Record<string, string>> = {
  // 2026-08-02. The self-test is what would let containment report PROVEN
  // rather than "not demonstrated". Nothing runs it, so boundaryProven is
  // false on every behavior eval today — which the eval already reports
  // honestly (#226), so this is a known gap and not a hidden one. Wiring it
  // needs a batch runner that can reach the canary hosts, which is real work
  // rather than a call site.
  "lib/containment/self-test.ts#runContainmentSelfTest": "no batch runner yet; boundaryProven stays false and is reported as unproven",
  "lib/containment/self-test.ts#mayStartBatch": "gates a batch runner that does not exist yet",

  // 2026-08-02. Reporting helpers with a surface still to be built. Each is
  // read-only: nothing is weaker for their absence, unlike the two fixed in
  // this change, which were enforcement.
  "lib/containment/budget.ts#budgetPressure": "read-only: for a budget gauge that has no page yet",
  "lib/agents/evals/behavior-eval.ts#gateBatch": "read-only: rolls runs into one verdict for a batch gate not yet built",
  "lib/platform-scan/anomaly/declared.ts#declaredHostList": "flattener for observations.unexplained(); run.ts uses explanationFor() directly",
  "lib/platform-scan/compliance/findings.ts#contactedThirdParties": "read-only appendix helper for a client report format not yet shipped",

  // 2026-08-28. Published for the OTHER side of the contract. An agent
  // operator receiving one of our delegations has to verify the signature we
  // send, and describing the construction in prose is how two implementations
  // end up disagreeing about whether a trailing newline is included. It has no
  // caller here because we sign; they verify. Its counterpart
  // delegationSignature IS called in production, so the pair cannot drift.
  "lib/ogiam/delegate.ts#verifyDelegationSignature": "published for external agent operators to verify a delegation we signed; we sign, they verify, so there is no caller on our side",
  "lib/ogiam/trends.ts#bucketSurfaces": "read-only: trend bucketing for a chart not yet built",
  "lib/ogiam/trends.ts#bucketRedTeam": "read-only: trend bucketing for a chart not yet built",
  "lib/ogiam/ledger.ts#computeOgiamEntryHash": "hash helper; the ledger writer computes the chain inline",
  "lib/ogiam/enforcement-policy.ts#__clearEnforcementCache": "cache reset used only by tests; named __ rather than the ForTests suffix",
};

/** Test seams are called only by tests BY DESIGN; that is what they are. */
const IS_TEST_SEAM = /^_.*ForTests$/;

function walk(dir: string, prefix: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__") continue;
    const abs = join(dir, entry);
    const rel = `${prefix}/${entry}`;
    if (statSync(abs).isDirectory()) walk(abs, rel, out);
    else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) out.push(rel);
  }
  return out;
}

/** Every .ts/.tsx under src, so "who calls this" is asked of the whole app. */
function allSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) allSourceFiles(abs, out);
    else if (/\.tsx?$/.test(entry)) out.push(abs);
  }
  return out;
}

/** Exported FUNCTION names only. A type or a constant being unused is a
 *  different, much weaker signal, and including them makes this noisy. */
function exportedFunctions(source: string): string[] {
  const names: string[] = [];
  for (const m of source.matchAll(/^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) names.push(m[1]);
  for (const m of source.matchAll(/^export\s+const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?\(/gm)) names.push(m[1]);
  return [...new Set(names)];
}

describe("no control ships without a caller", () => {
  const controlFiles = CONTROL_DIRS.flatMap((d) => {
    try {
      return walk(join(LIB, d), `lib/${d}`);
    } catch {
      return []; // directory not present in this checkout
    }
  });

  // Production callers only: __tests__ excluded, because being tested is
  // precisely what every inert control already was.
  const productionSources = allSourceFiles(SRC).filter((p) => !p.includes("__tests__"));
  const productionText = new Map(productionSources.map((p) => [p, readFileSync(p, "utf-8")]));

  it("scans a meaningful number of control files, so a broken walk cannot pass by finding nothing", () => {
    // A scanner that silently matches zero files reports success forever.
    expect(controlFiles.length).toBeGreaterThan(10);
    expect(productionSources.length).toBeGreaterThan(200);
  });

  it("every exported control function is called from production code", () => {
    const inert: string[] = [];

    for (const rel of controlFiles) {
      const abs = join(SRC, rel);
      const source = readFileSync(abs, "utf-8");
      for (const name of exportedFunctions(source)) {
        if (IS_TEST_SEAM.test(name)) continue;
        const key = `${rel}#${name}`;
        if (key in KNOWN_INERT) continue;

        // A symbol used by its OWN module is not inert: the module is the
        // unit, and exporting an internal helper so it can be tested directly
        // is a good practice, not a gap. Counting those flagged ~30 healthy
        // helpers on the first run and would have buried the real findings.
        const selfUses = (source.match(new RegExp(`\\b${name}\\b`, "g")) ?? []).length;
        if (selfUses > 1) continue;

        const used = productionSources.some((p) => {
          if (p === abs) return false;
          return new RegExp(`\\b${name}\\b`).test(productionText.get(p) ?? "");
        });
        if (!used) inert.push(key);
      }
    }

    expect({
      hint: "This control has no production caller, so it protects nothing. Wire it, or add it to KNOWN_INERT with the reason and the date.",
      inert,
    }).toEqual({ hint: expect.any(String), inert: [] });
  });

  it("has no stale KNOWN_INERT entry, so the list cannot overstate the debt", () => {
    const stale = Object.keys(KNOWN_INERT).filter((key) => {
      const [rel, name] = key.split("#");
      const abs = join(SRC, rel);
      return productionSources.some((p) => p !== abs && new RegExp(`\\b${name}\\b`).test(productionText.get(p) ?? ""));
    });
    expect({ hint: "Now has a caller. Remove it from KNOWN_INERT.", stale }).toEqual({
      hint: expect.any(String),
      stale: [],
    });
  });
});
