import { consolidateByOperator, deriveOperatorInsight, type OperatorViewJourney } from "@/lib/agent-operators-view";

function j(over: Partial<OperatorViewJourney> & { operatorKey: string }): OperatorViewJourney {
  const { operatorKey, ...rest } = over;
  return {
    key: rest.key ?? Math.random().toString(36),
    behaviorClass: "vuln_scanner",
    confidence: "inferred",
    firstAt: "2026-09-19T00:00:00Z",
    lastAt: "2026-09-19T00:00:00Z",
    path: [],
    eventCount: 1,
    ...rest,
    profile: {
      operatorKey,
      scaffolding: { pathDiscovery: "none", readsRobotsFirst: false },
      toolComposition: { usedTools: ["fetch"] },
      insights: [],
      ...(rest.profile ?? {}),
    } as OperatorViewJourney["profile"],
  };
}

describe("deriveOperatorInsight", () => {
  it("recommends BLOCK only on proven-hostile behavior, with a clear verdict", () => {
    const [g] = consolidateByOperator([
      j({ operatorKey: "op_x", behaviorClass: "exploit_attempt", confidence: "proven", path: ["/wp-login.php"],
          profile: { operatorKey: "op_x", scaffolding: { pathDiscovery: "path-guessing", readsRobotsFirst: true }, toolComposition: { usedTools: ["fetch", "submit_form"] }, insights: [{ kind: "payload_attack", attack: "sql_injection" }, { kind: "deliberate_violation" }] } }),
    ]);
    const ins = deriveOperatorInsight(g);
    expect(ins.verdict).toMatch(/proven hostile active exploitation/i);
    expect(ins.recommendedAction).toBe("block");
    expect(ins.tells).toEqual(expect.arrayContaining([expect.stringMatching(/sql_injection/i), expect.stringMatching(/deliberate/i)]));
  });

  it("escalates hostile-but-inferred rather than blocking", () => {
    const [g] = consolidateByOperator([
      j({ operatorKey: "op_i", behaviorClass: "vuln_scanner", confidence: "inferred", path: ["/.env"] }),
      j({ operatorKey: "op_i", behaviorClass: "vuln_scanner", confidence: "inferred", path: ["/wp-login.php"] }),
      j({ operatorKey: "op_i", behaviorClass: "vuln_scanner", confidence: "inferred", path: ["/xmlrpc.php"] }),
    ]);
    const ins = deriveOperatorInsight(g);
    expect(ins.recommendedAction).toBe("escalate");
    expect(ins.targeting).toMatch(/secrets-exposure|admin-surface/);
  });

  it("surfaces IDOR enumeration + runaway-loop tells (from the new behavior insights)", () => {
    const [g] = consolidateByOperator([
      j({ operatorKey: "op_b", behaviorClass: "vuln_scanner", path: ["/api/users/1"],
          profile: { operatorKey: "op_b", scaffolding: { pathDiscovery: "none", readsRobotsFirst: false }, toolComposition: { usedTools: ["fetch"] }, insights: [{ kind: "id_enumeration" }, { kind: "runaway_loop" }] } }),
    ]);
    const ins = deriveOperatorInsight(g);
    expect(ins.tells).toEqual(expect.arrayContaining([expect.stringMatching(/IDOR enumeration/i), expect.stringMatching(/resource exhaustion/i)]));
  });

  it("acknowledges a benign crawler", () => {
    const [g] = consolidateByOperator([j({ operatorKey: "op_ok", behaviorClass: "benign_crawler" })]);
    const ins = deriveOperatorInsight(g);
    expect(ins.recommendedAction).toBe("acknowledge");
  });
});
