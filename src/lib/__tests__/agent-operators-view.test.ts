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

describe("targeting signature (A) - descriptive granularity", () => {
  it("classifies targeted paths into attack categories with worst severity + count", () => {
    const [g] = consolidateByOperator([
      j({ operatorKey: "op_t", path: ["/.env"], key: "a" }),
      j({ operatorKey: "op_t", path: ["/wp-login.php"], key: "b" }),
      j({ operatorKey: "op_t", path: ["/xmlrpc.php"], key: "c" }),
    ]);
    const cats = Object.fromEntries(g.targeting.categories.map((c) => [c.category, c]));
    expect(cats["secrets-exposure"].severity).toBe("critical");
    expect(cats["admin-surface"].count).toBe(2); // /wp-login.php + /xmlrpc.php
    // secrets-exposure (critical) ranks ahead of admin-surface (medium)
    expect(g.targeting.categories[0].category).toBe("secrets-exposure");
    expect(g.targeting.topSeverity).toBe("critical");
  });

  it("collects payload types and computes a cadence", () => {
    const [g] = consolidateByOperator([
      j({ operatorKey: "op_c", firstAt: "2026-09-17T00:00:00Z", lastAt: "2026-09-19T00:00:00Z", path: ["/x"],
          profile: { operatorKey: "op_c", scaffolding: { pathDiscovery: "none", readsRobotsFirst: false }, toolComposition: { usedTools: ["fetch"] }, insights: [{ kind: "payload_attack", attack: "sql_injection" }] } }),
    ]);
    expect(g.targeting.payloadTypes).toContain("sql_injection");
    expect(g.targeting.cadence.spanHours).toBe(48);
    expect(g.targeting.summary).toMatch(/throws sql_injection/);
  });

  it("does NOT change the coarse operator key (blocklist/history stay valid)", () => {
    const [g] = consolidateByOperator([j({ operatorKey: "op_stable", path: ["/.env"] })]);
    expect(g.operatorKey).toBe("op_stable");
  });
});

describe("sub-actors (B) - finer identity without changing the durable key", () => {
  it("splits one coarse bucket into distinguishable targeting profiles", () => {
    const [g] = consolidateByOperator([
      // secrets probe
      j({ operatorKey: "op_split", path: ["/.env"], key: "a" }),
      j({ operatorKey: "op_split", path: ["/.git"], key: "b" }),
      // admin brute-force probe (a different targeting profile)
      j({ operatorKey: "op_split", path: ["/wp-login.php"], key: "c" }),
    ]);
    expect(g.subActors.length).toBe(2);
    // every sub-actor's fingerprint is anchored to the coarse key
    for (const sa of g.subActors) expect(sa.fingerprint.startsWith("op_split.")).toBe(true);
    const cats = g.subActors.flatMap((s) => s.categories).sort();
    expect(cats).toEqual(["admin-surface", "secrets-exposure"]);
  });

  it("keeps a single profile as ONE sub-actor (thin buckets do not fragment)", () => {
    const [g] = consolidateByOperator([
      j({ operatorKey: "op_one", path: ["/wp-login.php"], key: "a" }),
      j({ operatorKey: "op_one", path: ["/wp-admin"], key: "b" }),
    ]);
    expect(g.subActors.length).toBe(1); // both admin-surface, same path-discovery/toolset
    expect(g.subActors[0].findingCount).toBe(2);
  });

  it("is deterministic: same input, same sub-actor fingerprints", () => {
    const input = [j({ operatorKey: "op_det", path: ["/.env"], key: "a" }), j({ operatorKey: "op_det", path: ["/admin"], key: "b" })];
    const a = consolidateByOperator(input)[0].subActors.map((s) => s.fingerprint).sort();
    const b = consolidateByOperator(input)[0].subActors.map((s) => s.fingerprint).sort();
    expect(a).toEqual(b);
  });
});
