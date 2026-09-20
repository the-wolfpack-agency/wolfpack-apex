/**
 * The PQ inventory must classify EVERY algorithm in the registry (no crypto goes
 * unclassified in the chokepoint) and do so ACCURATELY - symmetric is resilient,
 * asymmetric signatures are the migration targets, ML-DSA is the reserved safe slot.
 */
import { ALGORITHMS, type AlgorithmId } from "@/lib/crypto/algorithms";
import { classifyAlgorithm, buildPqInventory } from "@/lib/crypto/pq-inventory";

describe("post-quantum crypto inventory", () => {
  it("classifies every registered algorithm (coverage gate)", () => {
    for (const id of Object.keys(ALGORITHMS) as AlgorithmId[]) {
      const c = classifyAlgorithm(id);
      expect(["symmetric_resilient", "quantum_vulnerable", "quantum_safe"]).toContain(c.pqClass);
    }
  });

  it("classifies accurately: symmetric resilient, asymmetric vulnerable, ML-DSA safe", () => {
    expect(classifyAlgorithm("hs256").pqClass).toBe("symmetric_resilient");
    expect(classifyAlgorithm("hs256").migrationTarget).toBe(false); // corrects the naive quantumSafe:false
    expect(classifyAlgorithm("es256").pqClass).toBe("quantum_vulnerable");
    expect(classifyAlgorithm("es256").migrationTarget).toBe(true);
    expect(classifyAlgorithm("rs256").migrationTarget).toBe(true);
    expect(classifyAlgorithm("ml-dsa-65-hybrid").pqClass).toBe("quantum_safe");
    expect(classifyAlgorithm("ml-dsa-65-hybrid").reserved).toBe(true);
  });

  it("reports an honest posture: exactly the asymmetric algorithms are the migration targets, ML-DSA reserved", () => {
    const inv = buildPqInventory();
    expect(inv.quantumVulnerable).toBe(2); // rs256 + es256
    expect(inv.quantumSafeAvailable).toBe(true);
    expect(inv.pqSlotImplemented).toBe(false); // reserved, fails closed
    expect(inv.summary).toMatch(/quantum-migration-ready, not quantum-safe today/i);
  });
});
