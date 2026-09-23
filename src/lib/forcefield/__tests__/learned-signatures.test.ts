/** @jest-environment node */
import {
  signatureHash,
  matchOperator,
  mineSignatures,
  eligibleForPromotion,
  evaluateLearnedSignatures,
  type OperatorDossierLite,
  type StoredSignature,
  type LearnedSignatureDeps,
} from "../learned-signatures";

describe("signatureHash", () => {
  it("is order-independent and dedupes", () => {
    expect(signatureHash(["b", "a", "a"])).toBe(signatureHash(["a", "b"]));
  });
  it("differs for different combos", () => {
    expect(signatureHash(["a", "b"])).not.toBe(signatureHash(["a", "c"]));
  });
});

describe("matchOperator", () => {
  const sig = ["payload_attack", "id_enumeration"];
  it("matches when the operator's tells are a superset", () => {
    expect(matchOperator(["id_enumeration", "payload_attack", "read_robots"], sig)).toBe(true);
  });
  it("does not match a partial overlap", () => {
    expect(matchOperator(["payload_attack", "read_robots"], sig)).toBe(false);
  });
  it("never matches a combo shorter than MIN_TELLS", () => {
    expect(matchOperator(["payload_attack"], ["payload_attack"])).toBe(false);
  });
});

describe("mineSignatures", () => {
  it("mines only from hostiles with >= 2 tells and counts prevalence by superset", () => {
    const dossiers: OperatorDossierLite[] = [
      { operatorKey: "h1", threatLevel: "hostile", tells: ["payload_attack", "id_enumeration"] },
      { operatorKey: "h2", threatLevel: "hostile", tells: ["payload_attack", "id_enumeration", "tripped_decoy"] },
      { operatorKey: "h3", threatLevel: "hostile", tells: ["payload_attack", "id_enumeration"] },
      { operatorKey: "b1", threatLevel: "benign", tells: ["read_robots", "read_sitemap"] }, // ignored
      { operatorKey: "e1", threatLevel: "elevated", tells: ["payload_attack", "id_enumeration"] }, // ignored (not hostile)
    ];
    const mined = mineSignatures(dossiers);
    const combo = mined.find((m) => m.tells.join(",") === "id_enumeration,payload_attack");
    // h1, h2, h3 all contain {payload_attack, id_enumeration} -> prevalence 3.
    expect(combo?.prevalence).toBe(3);
    expect(combo?.dangerous).toBe(true);
  });

  it("marks a combo of only weak tells as not dangerous", () => {
    const mined = mineSignatures([
      { operatorKey: "h1", threatLevel: "hostile", tells: ["read_robots", "read_sitemap"] },
      { operatorKey: "h2", threatLevel: "hostile", tells: ["read_robots", "read_sitemap"] },
    ]);
    expect(mined[0]?.dangerous).toBe(false);
  });

  it("returns nothing when there are no hostiles", () => {
    expect(mineSignatures([{ operatorKey: "b", threatLevel: "benign", tells: ["a", "b"] }])).toEqual([]);
  });
});

describe("eligibleForPromotion", () => {
  const base: StoredSignature = { sigHash: "s", tells: ["payload_attack", "id_enumeration"], dangerous: true, prevalence: 3, status: "shadow", shadowMatches: 2, falsePositiveHits: 0 };
  it("promotes when prevalence + dangerous + shadow matches + zero false positives", () => {
    expect(eligibleForPromotion(base)).toBe(true);
  });
  it("never promotes a non-dangerous combo", () => {
    expect(eligibleForPromotion({ ...base, dangerous: false })).toBe(false);
  });
  it("never promotes with any false positive", () => {
    expect(eligibleForPromotion({ ...base, falsePositiveHits: 1 })).toBe(false);
  });
  it("never promotes below the prevalence floor", () => {
    expect(eligibleForPromotion({ ...base, prevalence: 2 })).toBe(false);
  });
  it("never re-promotes an already-enforcing signature", () => {
    expect(eligibleForPromotion({ ...base, status: "enforcing" })).toBe(false);
  });
});

describe("evaluateLearnedSignatures (orchestration)", () => {
  function harness(dossiers: OperatorDossierLite[], stored: StoredSignature[]) {
    const calls = { shadowMatch: [] as string[], falsePositive: [] as string[], promoted: [] as string[], autoBlocked: [] as { op: string; reason: string }[] };
    const deps: LearnedSignatureDeps = {
      listDossiers: async () => dossiers,
      upsertSignature: async () => {},
      listSignatures: async () => stored,
      recordShadowMatch: async (h) => { calls.shadowMatch.push(h); },
      recordFalsePositive: async (h) => { calls.falsePositive.push(h); },
      promoteSignature: async (h) => { calls.promoted.push(h); },
      autoBlockOperator: async (op, reason) => { calls.autoBlocked.push({ op, reason }); return 2; },
      track: () => {},
    };
    return { deps, calls };
  }

  const sigTells = ["id_enumeration", "payload_attack"];

  it("SHADOW signature records a would-block but never auto-blocks a hostile", async () => {
    const stored: StoredSignature[] = [{ sigHash: "sig1", tells: sigTells, dangerous: true, prevalence: 3, status: "shadow", shadowMatches: 0, falsePositiveHits: 0 }];
    const { deps, calls } = harness(
      [{ operatorKey: "hX", threatLevel: "hostile", tells: [...sigTells, "read_robots"] }],
      stored,
    );
    const r = await evaluateLearnedSignatures(deps);
    expect(calls.shadowMatch).toEqual(["sig1"]);
    expect(calls.autoBlocked).toHaveLength(0);
    expect(r.operatorsAutoBlocked).toBe(0);
  });

  it("ENFORCING signature auto-blocks a matching hostile operator", async () => {
    const stored: StoredSignature[] = [{ sigHash: "sig1abcd", tells: sigTells, dangerous: true, prevalence: 3, status: "enforcing", shadowMatches: 2, falsePositiveHits: 0 }];
    const { deps, calls } = harness(
      [{ operatorKey: "hX", threatLevel: "hostile", tells: [...sigTells] }],
      stored,
    );
    const r = await evaluateLearnedSignatures(deps);
    expect(calls.autoBlocked).toEqual([{ op: "hX", reason: "learned:sig1abcd" }]);
    expect(r.operatorsAutoBlocked).toBe(1);
  });

  it("a welcomed/good agent matching a signature is a FALSE POSITIVE, never blocked", async () => {
    const stored: StoredSignature[] = [{ sigHash: "sig1", tells: sigTells, dangerous: true, prevalence: 3, status: "enforcing", shadowMatches: 2, falsePositiveHits: 0 }];
    const { deps, calls } = harness(
      [{ operatorKey: "good", threatLevel: "benign", welcomed: true, tells: [...sigTells] }],
      stored,
    );
    const r = await evaluateLearnedSignatures(deps);
    expect(calls.autoBlocked).toHaveLength(0);
    expect(calls.falsePositive).toEqual(["sig1"]);
    expect(r.falsePositives).toBe(1);
  });

  it("promotes a shadow signature that has earned it", async () => {
    const stored: StoredSignature[] = [{ sigHash: "sigReady", tells: sigTells, dangerous: true, prevalence: 3, status: "shadow", shadowMatches: 2, falsePositiveHits: 0 }];
    const { deps, calls } = harness([], stored);
    const r = await evaluateLearnedSignatures(deps);
    expect(calls.promoted).toEqual(["sigReady"]);
    expect(r.promoted).toBe(1);
  });
});
