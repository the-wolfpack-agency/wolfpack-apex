/**
 * THE AI CONTAINMENT BOUNDARY (architectural guardrail).
 *
 * Our safety + compliance posture rests on one architectural fact: the
 * deterministic cores make the authoritative decisions, and AI never runs in
 * their decision path. AI is a supplier of proposals/artifacts in the FACTORY
 * (offline, gated, human-reviewed), not an actor in production. See
 * docs/architecture/deterministic-runtime-ai-in-the-factory.md.
 *
 * This test makes that boundary a FACT, not a claim: it fails the build if any
 * file in a deterministic core calls a model (getAIClient) or an ML model
 * (getEmbeddingProvider), unless it is on the explicit, justified allowlist of
 * advisory, non-authoritative touchpoints.
 *
 * Note: deterministic utilities under @/lib/ai (e.g. @/lib/ai/redaction, a pure
 * regex redactor with no network call) are NOT model calls and are fine; the
 * signal we forbid is the MODEL CLIENT itself.
 */
import fs from "fs";
import path from "path";

const REPO = path.resolve(__dirname, "..", "..");

/** The deterministic decision cores. Code here decides; it must not call a model. */
const DETERMINISTIC_CORES = [
  "src/lib/compliance", // compliance report: covered/partial/gap from measured evidence
  "src/lib/readiness", // production-readiness grading from repo facts
  "src/lib/forcefield", // runtime agent-action containment (tripwire/contain)
  "src/lib/forcefield-web", // the Forcefield detection + enforcement engine
  "src/lib/platform-scan", // security scan + pentest engine
  "src/lib/ogiam", // the deterministic gate: "models advise, policy decides"
];

/** The ONLY model/ML call signals we forbid in a core. Deterministic helpers
 *  under @/lib/ai (redaction, types) deliberately do not match. */
const MODEL_CALL = /\bgetAIClient\b|\bgetEmbeddingProvider\b/;

/**
 * Advisory, non-authoritative AI touchpoints that are allowed to sit in a core
 * directory. Each is OFF by default, never in the enforcement/decision path, and
 * degrades to a typed non-answer. Adding an entry here is a deliberate decision
 * that a human reviews; it is the documented exception, not silent creep.
 */
const ADVISORY_ALLOWLIST: Record<string, string> = {
  "src/lib/forcefield-web/signup-risk-summary.ts":
    "Operator decision AID shown at signup review. Off unless configured, routed " +
    "through the governed model router, advisory only (the human approves/rejects). " +
    "Not in the detection or enforcement decision path.",
};

function sourceFiles(dir: string): string[] {
  const abs = path.join(REPO, dir);
  if (!fs.existsSync(abs)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name)) out.push(path.relative(REPO, full).split(path.sep).join("/"));
    }
  };
  walk(abs);
  return out;
}

describe("AI containment boundary: no model calls in the deterministic cores", () => {
  const files = DETERMINISTIC_CORES.flatMap(sourceFiles);

  it("scans a non-trivial number of core files (sanity)", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it("no core file calls a model except the explicit advisory allowlist", () => {
    const offenders = files.filter(
      (f) => MODEL_CALL.test(fs.readFileSync(path.join(REPO, f), "utf8")) && !(f in ADVISORY_ALLOWLIST),
    );
    expect(offenders).toEqual([]);
  });

  it("every allowlisted touchpoint still exists and still actually calls a model (no stale exceptions)", () => {
    for (const f of Object.keys(ADVISORY_ALLOWLIST)) {
      const abs = path.join(REPO, f);
      expect(fs.existsSync(abs)).toBe(true);
      expect(MODEL_CALL.test(fs.readFileSync(abs, "utf8"))).toBe(true);
    }
  });
});
