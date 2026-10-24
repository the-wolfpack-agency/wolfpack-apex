/** @jest-environment node */
import {
  signatureHash,
  matchOperator,
  mineSignatures,
  eligibleForPromotion,
  evaluateLearnedSignatures,
  trustBandOf,
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
  it("mines from every caught operator (hostile + elevated) with >= 2 tells, by superset prevalence", () => {
    const dossiers: OperatorDossierLite[] = [
      { operatorKey: "h1", threatLevel: "hostile", tells: ["payload_attack", "id_enumeration"] },
      { operatorKey: "h2", threatLevel: "hostile", tells: ["payload_attack", "id_enumeration", "tripped_decoy"] },
      { operatorKey: "e1", threatLevel: "elevated", tells: ["payload_attack", "id_enumeration"] }, // counts: elevated is caught
      { operatorKey: "b1", threatLevel: "benign", tells: ["payload_attack", "id_enumeration"] }, // ignored: benign
      { operatorKey: "w1", threatLevel: "elevated", welcomed: true, tells: ["payload_attack", "id_enumeration"] }, // ignored: welcomed
    ];
    const mined = mineSignatures(dossiers);
    const combo = mined.find((m) => m.tells.join(",") === "id_enumeration,payload_attack");
    // h1, h2, e1 contain {payload_attack, id_enumeration}; b1 and w1 excluded -> 3.
    expect(combo?.prevalence).toBe(3);
    expect(combo?.dangerous).toBe(true);
  });

  it("marks a combo of only weak tells as not dangerous (so it can never enforce)", () => {
    const mined = mineSignatures([
      { operatorKey: "e1", threatLevel: "elevated", tells: ["read_robots", "read_sitemap"] },
      { operatorKey: "e2", threatLevel: "elevated", tells: ["read_robots", "read_sitemap"] },
    ]);
    expect(mined[0]?.dangerous).toBe(false);
  });

  it("returns nothing when there are only benign/welcomed operators", () => {
    expect(mineSignatures([
      { operatorKey: "b", threatLevel: "benign", tells: ["a", "b"] },
      { operatorKey: "w", threatLevel: "elevated", welcomed: true, tells: ["a", "b"] },
    ])).toEqual([]);
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
    const calls = { shadowMatch: [] as string[], falsePositive: [] as string[], promoted: [] as string[], autoBlocked: [] as { op: string; reason: string }[], gate: [] as { proven: boolean; trustBand: string }[], tracked: [] as string[] };
    const deps: LearnedSignatureDeps = {
      listDossiers: async () => dossiers,
      upsertSignature: async () => {},
      listSignatures: async () => stored,
      recordShadowMatch: async (h) => { calls.shadowMatch.push(h); },
      recordFalsePositive: async (h) => { calls.falsePositive.push(h); },
      promoteSignature: async (h) => { calls.promoted.push(h); },
      autoBlockOperator: async (op, reason, input) => { calls.autoBlocked.push({ op, reason }); calls.gate.push(input); return 2; },
      track: async (event) => { await Promise.resolve(); calls.tracked.push(event); },
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

  it("passes proof + trust band to the auto-block gate (elevated maps to untrusted, never hostile)", async () => {
    const stored: StoredSignature[] = [{ sigHash: "sig1abcd", tells: sigTells, dangerous: true, prevalence: 3, status: "enforcing", shadowMatches: 2, falsePositiveHits: 0 }];
    const { deps, calls } = harness(
      [
        { operatorKey: "proven", threatLevel: "hostile", proven: true, tells: [...sigTells] },
        { operatorKey: "elev", threatLevel: "elevated", tells: [...sigTells] },
      ],
      stored,
    );
    await evaluateLearnedSignatures(deps);
    expect(calls.gate).toEqual([{ proven: true, trustBand: "hostile" }, { proven: false, trustBand: "untrusted" }]);
  });

  it("does not count an operator the gate refused (0 rows inserted)", async () => {
    const stored: StoredSignature[] = [{ sigHash: "sig1abcd", tells: sigTells, dangerous: true, prevalence: 3, status: "enforcing", shadowMatches: 2, falsePositiveHits: 0 }];
    const { deps, calls } = harness([{ operatorKey: "elev", threatLevel: "elevated", tells: [...sigTells] }], stored);
    deps.autoBlockOperator = async () => 0;
    const r = await evaluateLearnedSignatures(deps);
    expect(r.operatorsAutoBlocked).toBe(0);
    expect(calls.tracked).not.toContain("forcefield.signature_autoblocked");
  });

  it("DURABLE promotion event: signature_promoted is awaited before the pass returns", async () => {
    const stored: StoredSignature[] = [{ sigHash: "sigReady", tells: sigTells, dangerous: true, prevalence: 3, status: "shadow", shadowMatches: 2, falsePositiveHits: 0 }];
    const { deps, calls } = harness([], stored);
    await evaluateLearnedSignatures(deps);
    expect(calls.tracked).toContain("forcefield.signature_promoted");
  });

  it("a promotion that changed nothing is not counted and records no event", async () => {
    const stored: StoredSignature[] = [{ sigHash: "sigReady", tells: sigTells, dangerous: true, prevalence: 3, status: "shadow", shadowMatches: 2, falsePositiveHits: 0 }];
    const { deps, calls } = harness([], stored);
    deps.promoteSignature = async () => false;
    const r = await evaluateLearnedSignatures(deps);
    expect(r.promoted).toBe(0);
    expect(calls.tracked).not.toContain("forcefield.signature_promoted");
  });

  it("a promotion that throws is not counted", async () => {
    const stored: StoredSignature[] = [{ sigHash: "sigReady", tells: sigTells, dangerous: true, prevalence: 3, status: "shadow", shadowMatches: 2, falsePositiveHits: 0 }];
    const { deps } = harness([], stored);
    deps.promoteSignature = async () => { throw new Error("db"); };
    expect((await evaluateLearnedSignatures(deps)).promoted).toBe(0);
  });
});

describe("trustBandOf", () => {
  it("maps behavior to the gate's band", () => {
    expect(trustBandOf({ threatLevel: "hostile" })).toBe("hostile");
    expect(trustBandOf({ threatLevel: "elevated" })).toBe("untrusted");
    expect(trustBandOf({ threatLevel: "benign" })).toBe("caution");
    expect(trustBandOf({ threatLevel: "hostile", welcomed: true })).toBe("trusted");
  });
});
