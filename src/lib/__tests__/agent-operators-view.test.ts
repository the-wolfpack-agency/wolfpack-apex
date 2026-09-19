import { consolidateByOperator, type OperatorViewJourney } from "@/lib/agent-operators-view";

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

describe("consolidateByOperator", () => {
  it("groups findings by operator key and unions their targets", () => {
    const groups = consolidateByOperator([
      j({ operatorKey: "op_x", path: ["/wp-login.php"], key: "a" }),
      j({ operatorKey: "op_x", path: ["/xmlrpc.php"], key: "b" }),
      j({ operatorKey: "op_x", path: ["/.env"], key: "c" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].operatorKey).toBe("op_x");
    expect(groups[0].findingCount).toBe(3);
    expect(groups[0].paths.sort()).toEqual(["/.env", "/wp-login.php", "/xmlrpc.php"]);
  });

  it("labels a bare single-fetch bucket as coarse, honestly", () => {
    const [g] = consolidateByOperator([j({ operatorKey: "op_coarse", path: ["/admin"] })]);
    expect(g.grouping).toBe("coarse");
    expect(g.groupingReason).toMatch(/likely, not proven/i);
  });

  it("upgrades to distinctive when a finding has a discriminating fingerprint", () => {
    const [g] = consolidateByOperator([
      j({ operatorKey: "op_rich", eventCount: 5, profile: { operatorKey: "op_rich", scaffolding: { pathDiscovery: "link-following", readsRobotsFirst: true }, toolComposition: { usedTools: ["fetch", "submit_form"] }, insights: [] } }),
    ]);
    expect(g.grouping).toBe("distinctive");
  });

  it("upgrades a recurring coarse operator (3+ findings) to distinctive", () => {
    const groups = consolidateByOperator([
      j({ operatorKey: "op_rep", path: ["/a"] }), j({ operatorKey: "op_rep", path: ["/b"] }), j({ operatorKey: "op_rep", path: ["/c"] }),
    ]);
    expect(groups[0].grouping).toBe("distinctive");
    expect(groups[0].groupingReason).toMatch(/repeated pattern/i);
  });

  it("takes the worst severity across a group and collects payload attacks", () => {
    const groups = consolidateByOperator([
      j({ operatorKey: "op_m", behaviorClass: "vuln_scanner" }),
      j({ operatorKey: "op_m", behaviorClass: "exploit_attempt", profile: { operatorKey: "op_m", scaffolding: { pathDiscovery: "none", readsRobotsFirst: false }, toolComposition: { usedTools: ["fetch"] }, insights: [{ kind: "payload_attack", attack: "sql_injection" }] } }),
    ]);
    expect(groups[0].severity).toBe("hostile");
    expect(groups[0].attacks).toContain("sql_injection");
  });

  it("sorts operators worst-severity-first", () => {
    const groups = consolidateByOperator([
      j({ operatorKey: "op_benign", behaviorClass: "benign_crawler" }),
      j({ operatorKey: "op_hostile", behaviorClass: "vuln_scanner" }),
    ]);
    expect(groups[0].operatorKey).toBe("op_hostile");
  });
});
