import { consolidateByOperator, aggregateTradecraft, clusterByTradecraft, detectCampaigns, tradecraftTrend, matchOperatorsToNetwork, type OperatorViewJourney } from "@/lib/agent-operators-view";

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


describe("aggregateTradecraft - insights over ALL operators", () => {
  it("counts each tag by DISTINCT operators (a noisy single actor cannot dominate)", () => {
    const groups = consolidateByOperator([
      // operator A: two findings, both exploit_attempt + payload_attack
      j({ operatorKey: "op_a", behaviorClass: "exploit_attempt", key: "a1", profile: { operatorKey: "op_a", scaffolding: { pathDiscovery: "none", readsRobotsFirst: false }, toolComposition: { usedTools: ["fetch"] }, insights: [{ kind: "payload_attack", attack: "sqli" }] } }),
      j({ operatorKey: "op_a", behaviorClass: "exploit_attempt", key: "a2", profile: { operatorKey: "op_a", scaffolding: { pathDiscovery: "none", readsRobotsFirst: false }, toolComposition: { usedTools: ["fetch"] }, insights: [{ kind: "payload_attack", attack: "sqli" }] } }),
      // operator B: one finding, vuln_scanner
      j({ operatorKey: "op_b", behaviorClass: "vuln_scanner", key: "b1" }),
    ]);
    const tc = aggregateTradecraft(groups);
    const byTag = Object.fromEntries(tc.map((t) => [t.tag, t.operators]));
    // exploit_attempt shown by 1 distinct operator (A), despite 2 findings
    expect(byTag.exploit_attempt).toBe(1);
    expect(byTag.payload_attack).toBe(1);
    expect(byTag["attack:sqli"]).toBe(1);
    expect(byTag.vuln_scanner).toBe(1);
  });

  it("ranks the most prevalent tradecraft first, ties broken by tag name; drops unclassified", () => {
    const groups = consolidateByOperator([
      j({ operatorKey: "op_1", behaviorClass: "aggressive_scraper" }),
      j({ operatorKey: "op_2", behaviorClass: "aggressive_scraper" }),
      j({ operatorKey: "op_3", behaviorClass: "unclassified" }),
    ]);
    const tc = aggregateTradecraft(groups);
    expect(tc[0]).toEqual({ tag: "aggressive_scraper", operators: 2 });
    expect(tc.some((t) => t.tag === "unclassified")).toBe(false);
  });

  it("returns [] for no operators", () => {
    expect(aggregateTradecraft([])).toEqual([]);
  });
});


describe("clusterByTradecraft - operator similarity graph", () => {
  // helper: an operator with a chosen behavior class + insight kinds (its tells)
  const op = (operatorKey: string, behaviorClass: string, kinds: string[], key = operatorKey) =>
    j({ operatorKey, behaviorClass, key, confidence: "proven", profile: {
      operatorKey,
      scaffolding: { pathDiscovery: "link-following", readsRobotsFirst: true },
      toolComposition: { usedTools: ["fetch", "submit_form"] },
      insights: kinds.map((k) => ({ kind: k })),
    } });

  it("links two operators that share enough tradecraft into one cluster", () => {
    const groups = consolidateByOperator([
      op("op_a", "exploit_attempt", ["payload_attack", "id_enumeration"]),
      op("op_b", "exploit_attempt", ["payload_attack", "id_enumeration"]),
    ]);
    const clusters = clusterByTradecraft(groups);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].operatorKeys).toEqual(["op_a", "op_b"]);
    expect(clusters[0].sharedTells).toEqual(expect.arrayContaining(["exploit_attempt", "id_enumeration", "payload_attack"]));
    expect(clusters[0].cohesion).toBeGreaterThan(0.9); // identical tell-sets
    expect(clusters[0].proven).toBe(true);
  });

  it("does NOT link operators that merely share one ubiquitous tag", () => {
    const groups = consolidateByOperator([
      op("op_x", "vuln_scanner", []),
      op("op_y", "vuln_scanner", []),
    ]);
    // one shared tag (the class) is below minShared=2 -> no cluster
    expect(clusterByTradecraft(groups)).toEqual([]);
  });

  it("merges a chain transitively (A~B, B~C) into a single cluster", () => {
    const groups = consolidateByOperator([
      op("op_a", "exploit_attempt", ["payload_attack", "id_enumeration"]),
      op("op_b", "exploit_attempt", ["payload_attack", "id_enumeration", "tripped_decoy"]),
      op("op_c", "exploit_attempt", ["id_enumeration", "tripped_decoy"]),
    ]);
    const clusters = clusterByTradecraft(groups);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].operatorKeys).toEqual(["op_a", "op_b", "op_c"]);
  });

  it("keeps genuinely distinct operators in separate (here: no) clusters", () => {
    const groups = consolidateByOperator([
      op("op_a", "exploit_attempt", ["payload_attack", "id_enumeration"]),
      op("op_z", "form_spammer", ["form_honeypot"]),
    ]);
    expect(clusterByTradecraft(groups)).toEqual([]); // nothing shared
  });

  it("is deterministic and returns [] for a single operator", () => {
    const groups = consolidateByOperator([op("op_solo", "exploit_attempt", ["payload_attack"])]);
    expect(clusterByTradecraft(groups)).toEqual([]);
  });
});


describe("detectCampaigns - coordinated activity", () => {
  // op with shared tradecraft + a chosen active window + target paths
  const camp = (operatorKey: string, at: string, paths: string[], kinds: string[]) =>
    j({ operatorKey, behaviorClass: "exploit_attempt", confidence: "proven", key: operatorKey,
        firstAt: at, lastAt: at, path: paths,
        profile: {
          operatorKey,
          scaffolding: { pathDiscovery: "link-following", readsRobotsFirst: true },
          toolComposition: { usedTools: ["fetch", "submit_form"] },
          insights: kinds.map((k) => ({ kind: k })),
        } });

  it("reports a campaign when look-alike operators are concurrent AND share targets", () => {
    const groups = consolidateByOperator([
      camp("op_a", "2026-09-19T10:00:00Z", ["/api/users", "/login"], ["payload_attack", "id_enumeration"]),
      camp("op_b", "2026-09-19T10:20:00Z", ["/api/users", "/admin"], ["payload_attack", "id_enumeration"]),
    ]);
    const camps = detectCampaigns(groups);
    expect(camps).toHaveLength(1);
    expect(camps[0].operatorKeys).toEqual(["op_a", "op_b"]);
    expect(camps[0].sharedTargets).toEqual(["/api/users"]);
    expect(camps[0].concurrency).toBe(2);
    expect(camps[0].proven).toBe(true);
  });

  it("does NOT call it a campaign when methods match but they share no target", () => {
    const groups = consolidateByOperator([
      camp("op_a", "2026-09-19T10:00:00Z", ["/api/users"], ["payload_attack", "id_enumeration"]),
      camp("op_b", "2026-09-19T10:10:00Z", ["/different"], ["payload_attack", "id_enumeration"]),
    ]);
    expect(detectCampaigns(groups)).toEqual([]);
  });

  it("does NOT call it a campaign when methods + targets match but activity never overlaps", () => {
    const groups = consolidateByOperator([
      camp("op_a", "2026-01-01T10:00:00Z", ["/api/users"], ["payload_attack", "id_enumeration"]),
      camp("op_b", "2026-09-19T10:00:00Z", ["/api/users"], ["payload_attack", "id_enumeration"]),
    ]);
    // months apart, far beyond the hour of slack
    expect(detectCampaigns(groups)).toEqual([]);
  });
});

describe("tradecraftTrend - what is rising", () => {
  const at = (operatorKey: string, lastAt: string, kinds: string[], behaviorClass = "exploit_attempt") =>
    j({ operatorKey, behaviorClass, key: operatorKey, firstAt: lastAt, lastAt,
        profile: { operatorKey, scaffolding: { pathDiscovery: "none", readsRobotsFirst: false }, toolComposition: { usedTools: ["fetch"] }, insights: kinds.map((k) => ({ kind: k })) } });

  it("flags a brand-new tell (present only after the split) as isNew with a positive delta", () => {
    const groups = consolidateByOperator([
      at("op_old", "2026-09-01T00:00:00Z", ["id_enumeration"]),
      at("op_new", "2026-09-19T00:00:00Z", ["payload_attack"]),
    ]);
    const rows = tradecraftTrend(groups, "2026-09-10T00:00:00Z");
    const payload = rows.find((r) => r.tag === "payload_attack")!;
    expect(payload).toMatchObject({ recent: 1, prior: 0, delta: 1, isNew: true });
    const idenum = rows.find((r) => r.tag === "id_enumeration")!;
    expect(idenum).toMatchObject({ recent: 0, prior: 1, delta: -1, isNew: false });
  });

  it("ranks rising tradecraft first", () => {
    const groups = consolidateByOperator([
      at("op_1", "2026-09-19T00:00:00Z", ["payload_attack"]),
      at("op_2", "2026-09-19T00:00:00Z", ["payload_attack"]),
      at("op_3", "2026-09-01T00:00:00Z", ["runaway_loop"]),
    ]);
    const rows = tradecraftTrend(groups, "2026-09-10T00:00:00Z");
    expect(rows[0].tag).toBe("payload_attack");
    expect(rows[0].delta).toBe(2);
  });
});


describe("matchOperatorsToNetwork - recognize a network actor on first contact", () => {
  const mine = (operatorKey: string, kinds: string[], behaviorClass = "exploit_attempt") =>
    j({ operatorKey, behaviorClass, key: operatorKey,
        profile: { operatorKey, scaffolding: { pathDiscovery: "none", readsRobotsFirst: false }, toolComposition: { usedTools: ["fetch"] }, insights: kinds.map((k) => ({ kind: k })) } });

  it("flags a brand-new operator whose tradecraft matches a known network actor", () => {
    const groups = consolidateByOperator([mine("op_local", ["payload_attack", "id_enumeration"])]);
    const network = [{ tells: ["exploit_attempt", "payload_attack", "id_enumeration"], workspaceCount: 4, severity: "hostile" as const }];
    const matches = matchOperatorsToNetwork(groups, network);
    expect(matches).toHaveLength(1);
    expect(matches[0].operatorKey).toBe("op_local");
    expect(matches[0].networkWorkspaces).toBe(4);
    expect(matches[0].sharedTells).toEqual(["exploit_attempt", "id_enumeration", "payload_attack"]);
    expect(matches[0].similarity).toBeGreaterThan(0.9);
    expect(matches[0].severity).toBe("hostile");
  });

  it("does not match on a single shared tag (below minShared)", () => {
    const groups = consolidateByOperator([mine("op_local", [], "vuln_scanner")]);
    const network = [{ tells: ["vuln_scanner", "payload_attack", "id_enumeration"], workspaceCount: 3, severity: "hostile" as const }];
    expect(matchOperatorsToNetwork(groups, network)).toEqual([]);
  });

  it("keeps only the best match per operator and sorts by similarity", () => {
    const groups = consolidateByOperator([mine("op_local", ["payload_attack", "id_enumeration"])]);
    const network = [
      { tells: ["payload_attack", "id_enumeration", "exploit_attempt", "runaway_loop", "form_honeypot"], workspaceCount: 9, severity: "hostile" as const }, // lower jaccard
      { tells: ["exploit_attempt", "payload_attack", "id_enumeration"], workspaceCount: 2, severity: "hostile" as const }, // higher jaccard
    ];
    const matches = matchOperatorsToNetwork(groups, network);
    expect(matches).toHaveLength(1);
    expect(matches[0].networkWorkspaces).toBe(2); // the tighter match wins over the more-corroborated looser one
  });

  it("returns [] when there is no network corpus to match against", () => {
    const groups = consolidateByOperator([mine("op_local", ["payload_attack", "id_enumeration"])]);
    expect(matchOperatorsToNetwork(groups, [])).toEqual([]);
  });
});
