/**
 * Tests for src/lib/assistant/answer-quality.ts
 *
 * Each filter has happy-path + flagging-path + edge-cases. Aggregate
 * runner is tested for verdict computation and analytics emission.
 */

const mockTrack = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: any[]) => mockTrack(...a),
}));

import {
  MIN_CONFIDENCE_SCORE,
  STALE_DOC_AGE_MS,
  gateConfidence,
  validateEntities,
  requireCitations,
  detectStaleClaim,
  runAnswerQualityChecks,
  lowConfidenceMessage,
} from "@/lib/assistant/answer-quality";

beforeEach(() => mockTrack.mockClear());

/* ------------------------------------------------------------------ */
/* A1 confidence gate                                                  */
/* ------------------------------------------------------------------ */

describe("gateConfidence", () => {
  test("passes when score >= threshold + hits > 0", () => {
    expect(gateConfidence(MIN_CONFIDENCE_SCORE, 1)).toBeNull();
    expect(gateConfidence(0.9, 3)).toBeNull();
  });

  test("blocks when score below threshold", () => {
    const flag = gateConfidence(0.3, 5);
    expect(flag?.severity).toBe("block");
    expect(flag?.filter).toBe("confidence");
  });

  test("blocks when zero hits even at high score", () => {
    const flag = gateConfidence(0.9, 0);
    expect(flag?.severity).toBe("block");
  });

  test("no-ops when score undefined (no retrieval was attempted)", () => {
    expect(gateConfidence(undefined, undefined)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* A2 named-entity validation                                          */
/* ------------------------------------------------------------------ */

describe("validateEntities", () => {
  test("passes when every named entity is on the team roster", () => {
    expect(
      validateEntities(
        "Nick reviewed the doc with Jorge on April 12, 2026.",
        ["nick homyk", "jorge colon"],
      ),
    ).toBeNull();
  });

  test("flags an unknown name", () => {
    const flag = validateEntities(
      "Max Fuerst attended the kickoff with Sarah Williams.",
      ["nick homyk"],
    );
    expect(flag?.filter).toBe("entities");
    expect(flag?.reason).toMatch(/unfamiliar name/);
  });

  test("ignores common allowlist (Wolfpack, Microsoft, etc.)", () => {
    expect(
      validateEntities(
        "Wolfpack uses Microsoft Teams and SharePoint.",
        [],
      ),
    ).toBeNull();
  });

  test("ignores month / day names", () => {
    expect(
      validateEntities("On April 12 the team met on Monday.", []),
    ).toBeNull();
  });

  test("matches by first token (e.g. 'Max' vs 'Max Fuerst')", () => {
    expect(
      validateEntities("Max joined the call.", ["max fuerst"]),
    ).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* A3 citation requirement                                             */
/* ------------------------------------------------------------------ */

describe("requireCitations", () => {
  test("passes when every factual sentence cites a [ref:]", () => {
    const ans =
      "The Q3 launch is scheduled for August [ref:doc-1]. Pricing is finalized [ref:doc-2].";
    expect(requireCitations(ans, ["doc-1", "doc-2"])).toBeNull();
  });

  test("flags when a factual sentence is uncited", () => {
    const ans =
      "The Q3 launch is scheduled for August [ref:doc-1]. Pricing is final.";
    const flag = requireCitations(ans, ["doc-1"]);
    expect(flag?.filter).toBe("citations");
    expect(flag?.severity).toBe("warn");
  });

  test("no-ops when retrievedIds is empty (no sources to cite)", () => {
    expect(requireCitations("Anything you want.", [])).toBeNull();
  });

  test("ignores non-factual prose ('Let me know if you have more questions')", () => {
    const ans = "Let me know if you have any other questions.";
    expect(requireCitations(ans, ["doc-1"])).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* A4 stale-doc detection                                              */
/* ------------------------------------------------------------------ */

describe("detectStaleClaim", () => {
  const now = Date.parse("2026-05-14T00:00:00Z");

  test("passes when source is recent", () => {
    const recent = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
    expect(
      detectStaleClaim("Our pricing is $99/seat.", recent, now),
    ).toBeNull();
  });

  test("flags when present-tense claim + stale source", () => {
    const old = new Date(now - STALE_DOC_AGE_MS - 1).toISOString();
    const flag = detectStaleClaim("Our pricing is $99/seat.", old, now);
    expect(flag?.filter).toBe("stale");
    expect(flag?.severity).toBe("warn");
  });

  test("passes when stale source but past-tense claim", () => {
    const old = new Date(now - STALE_DOC_AGE_MS - 1).toISOString();
    expect(
      detectStaleClaim("Pricing was raised in 2024.", old, now),
    ).toBeNull();
  });

  test("no-ops when no source date available", () => {
    expect(
      detectStaleClaim("Our pricing is $99/seat.", null, now),
    ).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Aggregate runner                                                    */
/* ------------------------------------------------------------------ */

describe("runAnswerQualityChecks", () => {
  test("verdict=ok when nothing flags", () => {
    const r = runAnswerQualityChecks(
      {
        answer: "Nick reviewed the doc with Jorge [ref:doc-1].",
        topScore: 0.9,
        hitCount: 3,
        knownNames: ["nick", "jorge"],
        retrievedIds: ["doc-1"],
        topSourceUpdatedAt: new Date().toISOString(),
      },
      { userId: "u1", userRole: "cto" },
    );
    expect(r.verdict).toBe("ok");
    expect(r.flags).toEqual([]);
  });

  test("verdict=reject when confidence below threshold", () => {
    const r = runAnswerQualityChecks(
      {
        answer: "Anything plausible.",
        topScore: 0.2,
        hitCount: 1,
      },
      { userId: "u1", userRole: "cto" },
    );
    expect(r.verdict).toBe("reject");
    expect(r.flags[0].filter).toBe("confidence");
    expect(mockTrack).toHaveBeenCalledWith(
      "assistant.quality_flag_raised",
      "u1",
      "cto",
      expect.objectContaining({ filter: "confidence", verdict: "reject" }),
    );
  });

  test("verdict=low_confidence when only warn-level flags fire", () => {
    const r = runAnswerQualityChecks(
      {
        answer: "Max Fuerst joined the call.",
        topScore: 0.9,
        hitCount: 2,
        knownNames: ["nick"],
        retrievedIds: [],
      },
      { userId: "u1", userRole: "cto" },
    );
    expect(r.verdict).toBe("low_confidence");
    expect(r.flags.some((f) => f.filter === "entities")).toBe(true);
  });

  test("emits one analytics event per flag", () => {
    runAnswerQualityChecks(
      {
        answer: "Max says hi. Pricing is $99.",
        topScore: 0.9,
        hitCount: 2,
        knownNames: ["nick"],
        retrievedIds: ["doc-1"],
        topSourceUpdatedAt: new Date(
          Date.now() - STALE_DOC_AGE_MS - 1,
        ).toISOString(),
      },
      { userId: "u1", userRole: "cto" },
    );
    /* Three flags: entities (Max), citations (Pricing is $99), stale */
    expect(mockTrack).toHaveBeenCalledTimes(3);
  });
});

describe("lowConfidenceMessage", () => {
  test("returns a non-empty deterministic string", () => {
    const m = lowConfidenceMessage();
    expect(typeof m).toBe("string");
    expect(m.length).toBeGreaterThan(20);
  });
});
