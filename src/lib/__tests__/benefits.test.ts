/**
 * Benefits library unit tests — parser, scorer, insights, persistence.
 *
 * The parser is exercised against a fixture string that mirrors the
 * BCBS renewal exhibit format the user shipped (TWA Health Insurance
 * Plans PDF) so that the actual scoring rule we recommended in chat
 * (cheapest_practical → S9N1ADT-class plan) is enforced as a contract.
 */

const mockSafeQuery = jest.fn();
jest.mock("@/lib/db", () => ({
  safeQuery: (...args: unknown[]) => mockSafeQuery(...args),
}));
const mockTrackEvent = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: unknown[]) => mockTrackEvent(...args),
}));

import {
  extractPlanRows,
  scoreCheapestPractical,
  scoreLowestPremium,
  scoreLowestTotalCost,
  generateRecommendation,
  generateBenefitInsights,
  parseBenefitDocument,
  saveBenefitDocument,
  saveRecommendation,
  decideRecommendation,
  type BenefitPlan,
} from "@/lib/benefits";

// Synthetic fixture: a tiny BCBS-format renewal sample with 4 plans
// across HMO Silver and PPO Gold tiers, including one HSA. The parser
// should pull all 4 with correct deductibles, copays, and premiums.
const FIXTURE_TEXT = `
THE WOLFPACK AGENCY LLC
Account Number: 355195
Effective Date: Dec 1, 2025
Blue Cross Blue Shield

Blue Choice PPO Network
PPO Plans
Gold
G9K8CHC $1050// $6300// 80%// $55/$55 $100 $600// $100 $150// $10/$20/$70/ $8,774.95 $974.99 $1,949.98 $1,949.98 $2,924.97 $8,774.91
$2100 Unlimited 60% 80% $250 $120/$150/$250
G9L1CHC $2250// $6750// 80%// $35/$35 $70 $500// $75 $300// $10/$20/$70/ $8,639.39 $959.93 $1,919.86 $1,919.86 $2,879.79 $8,639.37
$4500 Unlimited 70% 80% $250 $120/$150/$250
Blue Advantage HMO Network
HMO Plans
Silver
S9N1ADT $4100// $9200// 60%// $0/$0 $90 $400// $150 DC// 80%/80%/70%/ $4,638.83 $515.43 $1,030.86 $1,030.86 $1,546.29 $4,638.87
Not Covered Not Covered Not Covered 60% DC 60%/60%/50%
S9N3ADT $4100// $8200// 80%// $0/$0 $110 $500// $150 $350// 80%/80%/70%/ $4,717.57 $524.11 $1,048.34 $1,048.34 $1,572.51 $4,717.53
Not Covered Not Covered Not Covered 80% DC 60%/60%/50%
HSA Plans*
Gold
G9E1ADT $3500// $3500// 100%// DC/DC DC DC// DC DC// 100% $5,361.63 $595.74 $1,191.48 $1,191.48 $1,787.22 $5,361.66
Not Covered Not Covered Not Covered 100% Not Covered
S9J3ADT $4100// $7200// 80%// DC/DC DC DC// DC DC// 80%/80%/70% $4,703.72 $522.64 $1,045.28 $1,045.28 $1,567.92 $4,703.76
Not Covered Not Covered Not Covered 80% Not Covered
`;

describe("extractPlanRows", () => {
  const result = extractPlanRows(FIXTURE_TEXT);

  it("detects carrier, account number, effective date", () => {
    expect(result.carrier).toBe("Blue Cross Blue Shield");
    expect(result.account_number).toBe("355195");
    expect(result.effective_date).toMatch(/Dec\s+1,?\s+2025/);
  });

  it("extracts all plan rows present in the fixture", () => {
    const ids = result.plans.map((p) => p.plan_id);
    expect(ids).toContain("G9K8CHC");
    expect(ids).toContain("G9L1CHC");
    expect(ids).toContain("S9N1ADT");
    expect(ids).toContain("S9N3ADT");
    expect(ids).toContain("G9E1ADT");
  });

  it("tags HMO vs PPO networks based on section headers", () => {
    const s9n1 = result.plans.find((p) => p.plan_id === "S9N1ADT");
    const g9k8 = result.plans.find((p) => p.plan_id === "G9K8CHC");
    expect(s9n1?.network).toBe("HMO");
    expect(g9k8?.network).toBe("PPO");
  });

  it("flags HSA plans", () => {
    const g9e1 = result.plans.find((p) => p.plan_id === "G9E1ADT");
    expect(g9e1?.is_hsa).toBe(true);
    const s9n1 = result.plans.find((p) => p.plan_id === "S9N1ADT");
    expect(s9n1?.is_hsa).toBe(false);
  });

  it("parses primary care copay numerically (S9N1ADT = $0)", () => {
    const s9n1 = result.plans.find((p) => p.plan_id === "S9N1ADT");
    expect(s9n1?.primary_care_copay_in_network).toBe(0);
  });

  it("parses individual deductible numerically", () => {
    const s9n1 = result.plans.find((p) => p.plan_id === "S9N1ADT");
    expect(s9n1?.individual_deductible_in_network).toBe(4100);
  });

  it("extracts the employee-only monthly premium", () => {
    const s9n1 = result.plans.find((p) => p.plan_id === "S9N1ADT");
    expect(s9n1?.monthly_premium_age_employee_only).toBe(515.43);
  });
});

const ALL_PLANS: BenefitPlan[] = extractPlanRows(FIXTURE_TEXT).plans;

describe("scoreCheapestPractical", () => {
  it("excludes HSA plans", () => {
    const scored = scoreCheapestPractical(ALL_PLANS);
    expect(scored.find((s) => s.plan.plan_id === "G9E1ADT")).toBeUndefined();
  });

  it("excludes plans with high primary care copay", () => {
    // Both S9N1ADT and S9N3ADT have $0 PCP — both should pass
    const scored = scoreCheapestPractical(ALL_PLANS);
    const ids = scored.map((s) => s.plan.plan_id);
    expect(ids).toContain("S9N1ADT");
    expect(ids).toContain("S9N3ADT");
  });

  it("ranks S9N1ADT first (the recommendation we gave the user in chat)", () => {
    const scored = scoreCheapestPractical(ALL_PLANS);
    expect(scored.length).toBeGreaterThan(0);
    expect(scored[0].plan.plan_id).toBe("S9N1ADT");
  });

  it("attaches human-readable reasons to each scored plan", () => {
    const scored = scoreCheapestPractical(ALL_PLANS);
    expect(scored[0].reasons.some((r) => /\$0 primary care/.test(r))).toBe(true);
    expect(scored[0].reasons.some((r) => /\$515/.test(r))).toBe(true);
  });
});

describe("scoreLowestPremium", () => {
  it("returns plans sorted by monthly premium ascending", () => {
    const scored = scoreLowestPremium(ALL_PLANS);
    for (let i = 1; i < scored.length; i++) {
      expect(scored[i].score).toBeGreaterThanOrEqual(scored[i - 1].score);
    }
  });
});

describe("scoreLowestTotalCost", () => {
  it("includes deductible expectation in total cost calculation", () => {
    const scored = scoreLowestTotalCost(ALL_PLANS);
    const reasons = scored[0].reasons.join(" ");
    expect(reasons).toMatch(/yr premium/);
    expect(reasons).toMatch(/expected deductible spend/);
    expect(reasons).toMatch(/Total/);
  });
});

describe("generateRecommendation", () => {
  it("returns S9N1ADT as the cheapest_practical winner with reasoning", () => {
    const rec = generateRecommendation(ALL_PLANS, "cheapest_practical");
    expect(rec).not.toBeNull();
    expect(rec!.plan.plan_id).toBe("S9N1ADT");
    expect(rec!.reasoning).toContain("S9N1ADT");
    expect(rec!.reasoning).toContain("HMO");
  });

  it("returns null when no plan satisfies the rule", () => {
    const rec = generateRecommendation([], "cheapest_practical");
    expect(rec).toBeNull();
  });

  it("includes runners-up so the UI can show comparable options", () => {
    const rec = generateRecommendation(ALL_PLANS, "cheapest_practical");
    expect(rec!.runners_up.length).toBeGreaterThan(0);
  });
});

describe("generateBenefitInsights", () => {
  it("calls out HMO-vs-PPO cost gap when HMO is cheaper", () => {
    const insights = generateBenefitInsights(ALL_PLANS);
    const titles = insights.map((i) => i.title);
    expect(titles.some((t) => /HMO is \$\d+\/mo cheaper than PPO/.test(t))).toBe(true);
  });

  it("warns about HSA plans with high OOP", () => {
    const insights = generateBenefitInsights(ALL_PLANS);
    expect(insights.some((i) => /HSA/i.test(i.title))).toBe(true);
  });

  it("highlights $0 primary care plans when they exist", () => {
    const insights = generateBenefitInsights(ALL_PLANS);
    expect(insights.some((i) => /\$0 primary care/.test(i.title))).toBe(true);
  });

  it("returns empty array on empty input (no false positives)", () => {
    expect(generateBenefitInsights([])).toEqual([]);
  });
});

describe("parseBenefitDocument with stub extractor", () => {
  it("uses the injected extractor and returns a structured document", async () => {
    const buf = Buffer.from("test");
    const doc = await parseBenefitDocument("test.pdf", buf, async () => ({
      text: FIXTURE_TEXT,
      numpages: 7,
    }));
    expect(doc.filename).toBe("test.pdf");
    expect(doc.page_count).toBe(7);
    expect(doc.plans.length).toBeGreaterThanOrEqual(5);
    expect(doc.carrier).toBe("Blue Cross Blue Shield");
  });
});

describe("persistence (saveBenefitDocument / saveRecommendation / decideRecommendation)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSafeQuery.mockResolvedValue({ rows: [] });
  });

  it("inserts document + every plan, fires hr.benefit_document_parsed", async () => {
    const doc = {
      filename: "test.pdf",
      carrier: "BCBS",
      effective_date: "2025-12-01",
      account_number: "355195",
      page_count: 7,
      size_bytes: 100,
      raw_text_excerpt: "...",
      plans: ALL_PLANS,
    };
    await saveBenefitDocument(doc, "user_1", "hr");
    // 1 INSERT for document + 1 INSERT per plan
    expect(mockSafeQuery).toHaveBeenCalledTimes(1 + ALL_PLANS.length);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "hr.benefit_document_parsed",
      "user_1",
      "hr",
      expect.objectContaining({ plan_count: ALL_PLANS.length }),
    );
  });

  it("saveRecommendation persists + fires hr.benefit_recommendation_generated", async () => {
    const rec = generateRecommendation(ALL_PLANS, "cheapest_practical")!;
    await saveRecommendation(rec, "doc_1", "user_1", "hr");
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "hr.benefit_recommendation_generated",
      "user_1",
      "hr",
      expect.objectContaining({ rule: "cheapest_practical", recommended_plan: "S9N1ADT" }),
    );
  });

  it("decideRecommendation fires the right accepted/rejected event", async () => {
    await decideRecommendation("rec_1", "accepted", "user_1", "hr");
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "hr.benefit_recommendation_accepted",
      "user_1",
      "hr",
      expect.objectContaining({ outcome: "accepted" }),
    );
    mockTrackEvent.mockClear();
    await decideRecommendation("rec_2", "rejected", "user_1", "hr");
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "hr.benefit_recommendation_rejected",
      "user_1",
      "hr",
      expect.objectContaining({ outcome: "rejected" }),
    );
  });
});
