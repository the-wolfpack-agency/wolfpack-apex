import { triageJourneys, severityOf, HOSTILE_CLASSES } from "@/lib/agent-triage";

function j(behaviorClass: string, confidence: "proven" | "inferred", lastAt = "2026-09-19T00:00:00Z") {
  return { behaviorClass, confidence, lastAt };
}

describe("agent triage", () => {
  it("maps attack classes to hostile, suspicious to elevated, the rest to benign", () => {
    expect(severityOf(j("aggressive_scraper", "inferred"))).toBe("hostile");
    expect(severityOf(j("vuln_scanner", "inferred"))).toBe("hostile");
    expect(severityOf(j("form_spammer", "proven"))).toBe("hostile");
    expect(severityOf(j("suspicious", "inferred"))).toBe("elevated");
    expect(severityOf(j("benign_crawler", "inferred"))).toBe("benign");
    expect(severityOf(j("unclassified", "inferred"))).toBe("benign");
    for (const c of ["aggressive_scraper", "vuln_scanner", "form_spammer"]) expect(HOSTILE_CLASSES.has(c)).toBe(true);
  });

  it("buckets and counts a mixed list", () => {
    const b = triageJourneys([
      j("vuln_scanner", "inferred"),
      j("aggressive_scraper", "proven"),
      j("suspicious", "inferred"),
      j("benign_crawler", "inferred"),
      j("unclassified", "inferred"),
    ]);
    expect(b.counts).toEqual({ total: 5, hostile: 2, elevated: 1, benign: 2, proven: 1, inferred: 4 });
    expect(b.hostile).toHaveLength(2);
    expect(b.elevated).toHaveLength(1);
    expect(b.benign).toHaveLength(2);
  });

  it("sorts proven above inferred within a bucket, then most-recent first", () => {
    const b = triageJourneys([
      j("vuln_scanner", "inferred", "2026-09-19T03:00:00Z"),
      j("vuln_scanner", "proven", "2026-09-19T01:00:00Z"),
      j("vuln_scanner", "inferred", "2026-09-19T05:00:00Z"),
    ]);
    expect(b.hostile[0].confidence).toBe("proven"); // proven first even though older
    expect(b.hostile[1].lastAt).toBe("2026-09-19T05:00:00Z"); // then newest inferred
    expect(b.hostile[2].lastAt).toBe("2026-09-19T03:00:00Z");
  });

  it("handles an empty list", () => {
    const b = triageJourneys([]);
    expect(b.counts.total).toBe(0);
    expect(b.hostile).toEqual([]);
  });
});
