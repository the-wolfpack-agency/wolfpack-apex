/**
 * The self-attack harness must PASS: every scenario drives an attack through the
 * real defense functions and the defense must hold. If any of these ever fails,
 * a change reopened a hole - which is exactly what this is here to catch.
 */
import { runAdversarialSuite } from "@/lib/forcefield/adversarial";

describe("adversarial self-attack suite", () => {
  it("defends against every scenario (fails loudly if a control regresses)", async () => {
    const report = await runAdversarialSuite();
    const undefended = report.results.filter((r) => !r.defended);
    // Surface which control regressed, not just a count.
    expect(undefended.map((r) => `${r.id}: ${r.detail}`)).toEqual([]);
    expect(report.allDefended).toBe(true);
    expect(report.defendedCount).toBe(report.total);
  });

  it("covers the core bypass classes (forged/tampered/replay/mandate/auto-block/good-bot/blocklist)", async () => {
    const ids = (await runAdversarialSuite()).results.map((r) => r.id);
    for (const id of ["forged-principal", "tampered-credential", "replay", "mandate-abuse", "auto-block-fires", "auto-block-spares-client", "good-bot-spared", "blocklist-enforced", "injection-as-data"]) {
      expect(ids).toContain(id);
    }
  });

  it("each scenario names the attack and the control it exercises", async () => {
    for (const r of (await runAdversarialSuite()).results) {
      expect(r.attack.length).toBeGreaterThan(10);
      expect(r.control.length).toBeGreaterThan(3);
    }
  });
});
