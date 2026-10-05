/**
 * Reliability scorer: each response is classified into a terminal outcome and
 * scored against what the case expected; the scorecard aggregates the rates that
 * answer "is it reliable for my SDLC flow".
 */
import {
  scoreCase, summarizeScorecard, heldReason, modelLimitationProfiles, formatLimitationProfile,
  type BenchResponse,
} from "@/lib/ai-code/benchmark-score";

const authored: BenchResponse = { run: { status: "ready_for_pr", diff: "d" }, executor: { author: "gpt-4o-mini" }, executorAttempts: 1 };
const escalatedAuthored: BenchResponse = { run: { status: "ready_for_pr", diff: "d" }, executor: { author: "DeepSeek-V4-Flash" }, executorAttempts: 2 };
const heldDup: BenchResponse = { run: { status: "needs_human" }, executor: { author: "gpt-4o-mini" }, duplication: { escalate: true }, executorAttempts: 1 };
const blockedSec: BenchResponse = { run: { status: "needs_human" }, executor: { author: "m" }, deepScan: { blocking: true }, executorAttempts: 1 };
const notReq: BenchResponse = { httpStatus: 400, notARequest: true };
const err500: BenchResponse = { httpStatus: 500 };

describe("scoreCase", () => {
  it("authored first-pass: ready + diff + one attempt", () => {
    const s = scoreCase("c1", "authored", authored);
    expect(s.outcome).toBe("authored");
    expect(s.firstPassReady).toBe(true);
    expect(s.escalated).toBe(false);
    expect(s.pass).toBe(true);
    expect(s.reason).toBe("n/a");
  });
  it("authored but escalated is NOT first-pass", () => {
    const s = scoreCase("c2", "authored", escalatedAuthored);
    expect(s.outcome).toBe("authored");
    expect(s.firstPassReady).toBe(false);
    expect(s.escalated).toBe(true);
    expect(s.pass).toBe(true);
  });
  it("a dup hold is 'held' and matches an expectation of held", () => {
    expect(scoreCase("c3", "held", heldDup).outcome).toBe("held");
    expect(scoreCase("c3", "held", heldDup).pass).toBe(true);
  });
  it("a security block is 'blocked' and matches an adversarial expectation", () => {
    expect(scoreCase("c4", "blocked", blockedSec).outcome).toBe("blocked");
    expect(scoreCase("c4", "blocked", blockedSec).pass).toBe(true);
  });
  it("an authored change that was EXPECTED to be blocked FAILS the case", () => {
    expect(scoreCase("c5", "blocked", authored).pass).toBe(false); // the adversarial slipped
  });
  it("intent-gate refusal counts as blocked", () => {
    expect(scoreCase("c6", "blocked", notReq).outcome).toBe("blocked");
  });
  it("a 500 is an error outcome (never counts as authored)", () => {
    expect(scoreCase("c7", "authored", err500).outcome).toBe("error");
    expect(scoreCase("c7", "authored", err500).pass).toBe(false);
  });
});

describe("heldReason", () => {
  it("names the dominant blocker for each hold", () => {
    expect(heldReason({ httpStatus: 400, notARequest: true })).toBe("intent-refused");
    expect(heldReason({ httpStatus: 422 })).toBe("no-change");
    expect(heldReason({ deepScan: { blocking: true } })).toBe("security");
    expect(heldReason({ duplication: { escalate: true } })).toBe("duplication");
    expect(heldReason({ anchorFailures: [{}] })).toBe("anchor-failure");
    expect(heldReason({ phantomImports: [{}] })).toBe("broken-imports");
    expect(heldReason({ brokenLocalImports: [{}] })).toBe("broken-imports");
    expect(heldReason({ incompleteFiles: [{}] })).toBe("incomplete-output");
    expect(heldReason({ run: { status: "needs_human" } })).toBe("needs-human-other");
  });
  it("precedence: security beats duplication", () => {
    expect(heldReason({ deepScan: { blocking: true }, duplication: { escalate: true } })).toBe("security");
  });
});

describe("summarizeScorecard", () => {
  it("computes the headline rates", () => {
    const scores = [
      scoreCase("a", "authored", authored),            // authored, first-pass, pass
      scoreCase("b", "authored", escalatedAuthored),   // authored, escalated, pass
      scoreCase("c", "held", heldDup),                 // held, pass
      scoreCase("d", "blocked", blockedSec),           // blocked, pass
      scoreCase("e", "blocked", authored),             // slipped -> fail
    ];
    const card = summarizeScorecard(scores);
    expect(card.total).toBe(5);
    expect(card.authored).toBe(3);        // a, b, e(authored)
    expect(card.firstPassReadyRate).toBeCloseTo(2 / 5, 5); // a + e both authored first-pass (e is a slip - caught by expectationMatchRate, not here)
    expect(card.escalationRate).toBeCloseTo(1 / 5, 5);     // only `b`
    expect(card.expectationMatchRate).toBeCloseTo(4 / 5, 5); // all but `e`
    // held/blocked cases counted by reason (heldDup -> duplication, blockedSec -> security)
    expect(card.reasonBreakdown).toMatchObject({ duplication: 1, security: 1 });
  });
  it("is zeroed on empty", () => {
    expect(summarizeScorecard([]).total).toBe(0);
    expect(summarizeScorecard([]).firstPassReadyRate).toBe(0);
  });
});

describe("modelLimitationProfiles (per-model ground-truth limitation tracking)", () => {
  // broken-imports hold authored by a small model, EXPECTED to author -> a real limitation
  const smallBrokenImports: BenchResponse = {
    run: { status: "needs_human" }, executor: { author: "gpt-4o-mini" },
    brokenLocalImports: [{}], executorAttempts: 1,
  };
  it("charges a limitation only when the model was expected to author and was withheld", () => {
    const scores = [
      scoreCase("imp", "authored", smallBrokenImports), // gpt-4o-mini: broken-imports limitation
      scoreCase("ok", "authored", authored),            // gpt-4o-mini: clean author
      scoreCase("adv", "blocked", blockedSec),          // model "m" correctly blocked -> NOT a limitation
    ];
    const profiles = modelLimitationProfiles(scores);
    const small = profiles.find((p) => p.model === "gpt-4o-mini")!;
    expect(small.authoringTasks).toBe(2);
    expect(small.limitations["broken-imports"]).toEqual({ count: 1, rate: 0.5 });
    // the correctly-blocked adversarial case is NOT charged against model "m"
    const m = profiles.find((p) => p.model === "m")!;
    expect(m.limitations).toEqual({});
  });
  it("excludes cases with no authoring model (an intent-gate refusal)", () => {
    const profiles = modelLimitationProfiles([scoreCase("greet", "blocked", notReq)]);
    expect(profiles).toEqual([]); // notReq has model "" -> nothing to attribute
  });
  it("computes per-model first-pass / escalation / match rates", () => {
    const profiles = modelLimitationProfiles([
      scoreCase("a", "authored", authored),          // gpt-4o-mini first-pass pass
      scoreCase("b", "authored", escalatedAuthored), // DeepSeek escalated pass
    ]);
    const small = profiles.find((p) => p.model === "gpt-4o-mini")!;
    expect(small.firstPassRate).toBe(1);
    expect(small.escalationRate).toBe(0);
    const deep = profiles.find((p) => p.model === "DeepSeek-V4-Flash")!;
    expect(deep.escalationRate).toBe(1);
    expect(deep.firstPassRate).toBe(0);
  });
  it("formatLimitationProfile renders a one-line summary, limitations highest-rate first", () => {
    const [p] = modelLimitationProfiles([
      scoreCase("imp", "authored", smallBrokenImports),
      scoreCase("ok", "authored", authored),
    ]);
    const line = formatLimitationProfile(p);
    expect(line).toContain("[profile] gpt-4o-mini");
    expect(line).toContain("broken-imports=50%");
    expect(line).toContain("firstPass=50%");
  });
});
