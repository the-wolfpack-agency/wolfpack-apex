/**
 * Adversarial verification: run every profile in the corpus through the REAL
 * deterministic engine (decideEnforcement) and prove it blocks what it should,
 * never blocks a real visitor, and fires the right reason. This is the CI-gating
 * "we actually block the agents we profile" proof. The live end-to-end run against
 * a deployed shim reuses the same corpus (scripts/forcefield-redteam.ts).
 */
import { decideEnforcement } from "../enforce";
import { DEFAULT_RULESET } from "../ruleset";
import { ADVERSARIAL_CORPUS } from "../adversarial-corpus";

function decide(c: (typeof ADVERSARIAL_CORPUS)[number]) {
  return decideEnforcement(
    { path: c.input.path, rawUrl: c.input.rawUrl ?? c.input.path, method: c.input.method, userAgent: c.input.userAgent, headerNames: c.input.headerNames },
    DEFAULT_RULESET,
  );
}

it.each(ADVERSARIAL_CORPUS.map((c) => [c.name, c] as const))(
  "%s -> engine verdict matches the expected outcome",
  (_name, c) => {
    const d = decide(c);
    expect(d.block).toBe(c.expectBlock);
    if (c.expectBlock && c.expectReason) expect(d.reasonKind).toBe(c.expectReason);
  },
);

it("blocks 100% of the hostile cases (detection + enforcement works)", () => {
  const hostile = ADVERSARIAL_CORPUS.filter((c) => c.kind === "hostile");
  const blocked = hostile.filter((c) => decide(c).block);
  expect(hostile.length).toBeGreaterThanOrEqual(10);
  expect(blocked.length).toBe(hostile.length); // every proven-hostile profile is blocked
});

it("ZERO false positives: never blocks a benign visitor or good bot", () => {
  const benign = ADVERSARIAL_CORPUS.filter((c) => c.kind === "benign");
  const wronglyBlocked = benign.filter((c) => decide(c).block).map((c) => c.name);
  expect(benign.length).toBeGreaterThanOrEqual(4);
  expect(wronglyBlocked).toEqual([]); // a false positive is the worst outcome
});

it("recon is report-only: suspicious-but-unproven is never blocked", () => {
  for (const c of ADVERSARIAL_CORPUS.filter((x) => x.kind === "recon")) {
    expect(decide(c).block).toBe(false);
  }
});
