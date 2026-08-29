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

const mockSafeQuery = jest.fn();
jest.mock("@/lib/db", () => ({
  safeQuery: (...a: any[]) => mockSafeQuery(...a),
}));

import {
  gateUngroundedClaimAboutUs,
  gateMetaCommentary,
  MIN_CONFIDENCE_SCORE,
  STALE_DOC_AGE_MS,
  gateConfidence,
  validateEntities,
  requireCitations,
  detectStaleClaim,
  runAnswerQualityChecks,
  lowConfidenceMessage,
  validateCitations,
  getAssistantStrictness,
  __resetStrictnessCacheForTests,
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

  test("no-ops when zero hits (general-knowledge answer, nothing to gate)", () => {
    /* Prior behavior was `block` here — that killed every general-
       knowledge answer because tryBrain returned topScore: 0 with no
       hits when DB was empty. The correct semantic: if no grounding
       was retrieved, the answer isn't claiming brain-backing, so
       there's nothing to confidence-gate. (Regression 2026-05-14.) */
    expect(gateConfidence(0.9, 0)).toBeNull();
    expect(gateConfidence(0, 0)).toBeNull();
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

  /* Regression 2026-05-16: SharePoint-grounded answer flagged
     "Brand Ambassador", "Training", "Includes" as unfamiliar names.
     None of these are personal names. Several false-positive
     categories addressed below. */

  test("ignores common verbs/nouns capitalized as list-item leads", () => {
    /* "Includes" and "Covers" lead bullets; both are verbs, not names. */
    expect(
      validateEntities(
        "- Includes foundational skills for the program.\n- Covers customer engagement.",
        [],
      ),
    ).toBeNull();
  });

  test("ignores common section labels like 'Training' / 'Source' at line start", () => {
    expect(
      validateEntities(
        "Training: foundational skills.\nSource: BA101 document.",
        [],
      ),
    ).toBeNull();
  });

  test("ignores job-title phrases (Brand Ambassador, Account Manager)", () => {
    expect(
      validateEntities(
        "The Brand Ambassador 101 training covers customer engagement.",
        [],
      ),
    ).toBeNull();
    expect(
      validateEntities(
        "Account Manager training is also available.",
        [],
      ),
    ).toBeNull();
  });

  test("still flags real unknown names (no over-correction)", () => {
    const flag = validateEntities(
      "Cyrus Vanderpool joined the meeting yesterday.",
      [],
    );
    expect(flag).not.toBeNull();
    expect(flag?.reason).toMatch(/Cyrus Vanderpool/);
  });

  test("real names still flagged even at sentence start (no over-correction)", () => {
    const flag = validateEntities("Mortimer joined the deal.", []);
    expect(flag).not.toBeNull();
    expect(flag?.reason).toMatch(/Mortimer/);
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

/* ------------------------------------------------------------------ */
/* Per-workspace strictness                                            */
/* ------------------------------------------------------------------ */

describe("strictness + runAnswerQualityChecks", () => {
  test("permissive: warn-only flags → verdict low_confidence", () => {
    const r = runAnswerQualityChecks(
      {
        answer: "Max Fuerst joined the call.",
        topScore: 0.9,
        hitCount: 1,
        knownNames: ["nick"],
        retrievedIds: [],
      },
      { userId: "u1", userRole: "cto", strictness: "permissive" },
    );
    expect(r.verdict).toBe("low_confidence");
  });

  test("strict: warn-only flags → verdict reject (no LLM voice under doubt)", () => {
    const r = runAnswerQualityChecks(
      {
        answer: "Max Fuerst joined the call.",
        topScore: 0.9,
        hitCount: 1,
        knownNames: ["nick"],
        retrievedIds: [],
      },
      { userId: "u1", userRole: "cto", strictness: "strict" },
    );
    expect(r.verdict).toBe("reject");
    expect(mockTrack).toHaveBeenCalledWith(
      "assistant.quality_flag_raised",
      "u1",
      "cto",
      expect.objectContaining({ verdict: "reject", strictness: "strict" }),
    );
  });

  test("strict + zero flags → verdict still ok (no false positives)", () => {
    const r = runAnswerQualityChecks(
      {
        answer: "Nick reviewed the doc [ref:doc-1].",
        topScore: 0.9,
        hitCount: 1,
        knownNames: ["nick"],
        retrievedIds: ["doc-1"],
      },
      { userId: "u1", userRole: "cto", strictness: "strict" },
    );
    expect(r.verdict).toBe("ok");
    expect(r.flags).toEqual([]);
  });
});

describe("getAssistantStrictness", () => {
  const ORIGINAL_DB_URL = process.env.DATABASE_URL;
  beforeEach(() => {
    __resetStrictnessCacheForTests();
    mockSafeQuery.mockReset();
    process.env.DATABASE_URL = "postgres://test";
  });
  afterAll(() => {
    if (ORIGINAL_DB_URL === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = ORIGINAL_DB_URL;
  });

  test("returns 'permissive' when shadow mode (no DATABASE_URL)", async () => {
    delete process.env.DATABASE_URL;
    expect(await getAssistantStrictness()).toBe("permissive");
    expect(mockSafeQuery).not.toHaveBeenCalled();
  });

  test("returns 'strict' when workspace row says strict", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [{ assistant_strictness: "strict" }],
    });
    expect(await getAssistantStrictness()).toBe("strict");
  });

  test("returns 'permissive' when workspace row says permissive", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [{ assistant_strictness: "permissive" }],
    });
    expect(await getAssistantStrictness()).toBe("permissive");
  });

  test("returns 'permissive' when row missing or column null (pre-migration)", async () => {
    mockSafeQuery.mockResolvedValueOnce({ rows: [] });
    expect(await getAssistantStrictness()).toBe("permissive");
  });

  test("caches in-process — second call within 60s does not re-query", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [{ assistant_strictness: "strict" }],
    });
    await getAssistantStrictness();
    await getAssistantStrictness();
    expect(mockSafeQuery).toHaveBeenCalledTimes(1);
  });

  test("returns 'permissive' on DB error (fail-open — assistant remains usable)", async () => {
    mockSafeQuery.mockRejectedValueOnce(new Error("DB down"));
    expect(await getAssistantStrictness()).toBe("permissive");
  });
});

/* ------------------------------------------------------------------ */
/* Citation validation (tenant-scoped)                                 */
/* ------------------------------------------------------------------ */

describe("validateCitations", () => {
  test("keeps valid [ref:X] tokens, returns kept ID set", () => {
    const r = validateCitations(
      "The launch is set for August [ref:doc-1]. Pricing finalized [ref:doc-2].",
      ["doc-1", "doc-2"],
    );
    expect(r.cleanAnswer).toContain("[ref:doc-1]");
    expect(r.cleanAnswer).toContain("[ref:doc-2]");
    expect(r.keptRefs.sort()).toEqual(["doc-1", "doc-2"]);
    expect(r.droppedRefs).toEqual([]);
  });

  test("strips [ref:X] tokens not in validSourceIds (invented citations)", () => {
    const r = validateCitations(
      "The launch is in August [ref:doc-1]. Margin is 40% [ref:doc-42].",
      ["doc-1"],
    );
    expect(r.cleanAnswer).toContain("[ref:doc-1]");
    expect(r.cleanAnswer).not.toContain("[ref:doc-42]");
    expect(r.cleanAnswer).toContain("Margin is 40%.");
    expect(r.droppedRefs).toEqual(["doc-42"]);
    expect(r.keptRefs).toEqual(["doc-1"]);
  });

  test("empty validSourceIds strips every citation", () => {
    const r = validateCitations(
      "First [ref:a] second [ref:b].",
      [],
    );
    expect(r.cleanAnswer).not.toMatch(/\[ref:/);
    expect(r.droppedRefs.sort()).toEqual(["a", "b"]);
  });

  test("handles empty answer gracefully", () => {
    const r = validateCitations("", ["doc-1"]);
    expect(r.cleanAnswer).toBe("");
    expect(r.droppedRefs).toEqual([]);
    expect(r.keptRefs).toEqual([]);
  });

  test("collapses double-spaces left by stripped tokens", () => {
    const r = validateCitations(
      "Note  [ref:fake]  here.",
      [],
    );
    expect(r.cleanAnswer).toBe("Note here.");
  });
});

/**
 * Sentence-initial capitals are not names.
 *
 * Reported 2026-08-04: the assistant appended
 *   "Note: this answer may need a second look. answer mentions 1 unfamiliar
 *    name(s): However."
 * to an ordinary reply. "However" begins a sentence, so it is capitalised by
 * position, and the proper-name regex read it as somebody the org does not know.
 *
 * That undermines the warning itself: a reader who sees it fire on "However"
 * learns to ignore it, including the times it is right about a hallucinated
 * person.
 */
describe("validateEntities — sentence-initial capitals", () => {
  const KNOWN = ["Jorge Colon", "Max Fuerst"];

  test("does not flag 'However' at the start of a sentence — the report", () => {
    const answer =
      "I cannot view screenshots directly. However, if you describe the data I can help.";
    expect(validateEntities(answer, KNOWN)).toBeNull();
  });

  test.each([
    "Therefore, the invite was resent.",
    "Additionally, the report is attached.",
    "Unfortunately, that request could not be completed.",
    "Meanwhile, the sync is still running.",
    "Nevertheless, the deploy succeeded.",
    "Please review the attached summary.",
    "This covers the whole quarter.",
    "Based on the numbers, revenue is up.",
    "Finally, the migration completed.",
  ])("does not flag the opener in %j", (answer) => {
    expect(validateEntities(answer, KNOWN)).toBeNull();
  });

  test("a real name after a discourse marker is still checked", () => {
    /* Dropping the positional capital must not swallow what follows it. */
    const flag = validateEntities("However Bartholomew disagreed.", KNOWN);
    expect(flag).not.toBeNull();
    expect(flag?.reason).toContain("Bartholomew");
  });

  test("a known name after a discourse marker stays quiet", () => {
    expect(validateEntities("However Jorge disagreed.", KNOWN)).toBeNull();
  });

  test("the same word mid-sentence is still flagged", () => {
    /* Mid-sentence the capital was a choice, so it still carries signal. */
    const flag = validateEntities("The deal closed with Winchester today.", KNOWN);
    expect(flag).not.toBeNull();
    expect(flag?.reason).toContain("Winchester");
  });

  test("an unfamiliar name opening a sentence is NOT excused", () => {
    /* The fix must not make the whole check toothless: only closed-class
       English words are dropped, never an arbitrary capitalised word. */
    const flag = validateEntities("Bartholomew approved the invoice.", KNOWN);
    expect(flag).not.toBeNull();
    expect(flag?.reason).toContain("Bartholomew");
  });

  test("a bullet list opener is treated as a sentence start", () => {
    expect(validateEntities("- However, the totals differ.", KNOWN)).toBeNull();
  });
});

describe("validateEntities — the openers reported on 2026-08-19", () => {
  /* A user typed "what is up?" and was told the answer "mentions 2 unfamiliar
     name(s): Ready, What's." The reply was correct; the warning above it was
     not, and a hedge over a right answer is worse than no hedge at all. */
  const KNOWN_PEOPLE = ["Jorge Colon", "Alicia Zulker"];

  test("the exact reply that was flagged is now clean", () => {
    expect(
      validateEntities("Ready to help with anything you need. What's the task?", KNOWN_PEOPLE),
    ).toBeNull();
  });

  test("a contraction is not a name, whichever apostrophe is used", () => {
    // "What's" reached the reader because the list holds "what" and the
    // apostrophe made it a different string.
    expect(validateEntities("What's next on the list?", KNOWN_PEOPLE)).toBeNull();
    expect(validateEntities("What’s next on the list?", KNOWN_PEOPLE)).toBeNull();
    expect(validateEntities("They're ready. It'll be fine.", KNOWN_PEOPLE)).toBeNull();
  });

  test("small talk, which is what people try first, produces no warning", () => {
    for (const answer of [
      "Happy to help. Let me know what you need.",
      "Sure thing. Here is the summary.",
      "Good morning. Nothing is overdue today.",
      "Thanks for confirming. Sounds like a plan.",
    ]) {
      // Named in the array so a failure says which answer broke.
      expect([answer, validateEntities(answer, KNOWN_PEOPLE)]).toEqual([answer, null]);
    }
  });

  test("but an invented name still gets flagged, including at a sentence start", () => {
    /* The check keeps its teeth. This is the line the fix must not cross:
       silencing the warning entirely would be worse than the false positives,
       because inventing a colleague is the failure it exists to catch. */
    const flag = validateEntities("Bartholomew approved the invoice.", KNOWN_PEOPLE);
    expect(flag).not.toBeNull();
    expect(flag?.reason).toContain("Bartholomew");
  });
});

/* ---------------------------------------------------------------------
 * A name the model READ cannot have been invented by it.
 *
 * #271 fixed the sentence-opener and contraction cases. It did not fix the
 * larger one, and said so: the check compares against the team roster, so
 * every proper noun in a client's own documents reads as a fabrication.
 *
 * Observed three times on 2026-08-26, against real answers:
 *   "answer mentions 4 unfamiliar name(s): Ritz Carlton, Intercontinental,
 *    Hilton Hotel."
 *
 * Those are training venues, in Porsche's own survey exports, which this
 * product had ingested itself an hour earlier. Warning that a correct answer
 * is invented is worse than not warning at all: it teaches people to distrust
 * the answers that are good, and in front of a client it is the single most
 * damaging sentence the product can emit.
 * --------------------------------------------------------------- */
describe("names corroborated by the material they came from", () => {
  const ROSTER = ["jorge colon", "ashley lindsey"];

  it("does not flag a venue that appears in the retrieved text", () => {
    /* Opening on a listed word deliberately, so this asserts corroboration
       and nothing else. Sentence-initial nouns are a separate class, still
       imperfect after #271, and noted at the end of this block. */
    const answer = "The training was held at the Ritz Carlton Las Colinas in August.";
    const grounding =
      "Survey Data PCBA_101 — training session held at the Ritz Carlton Las Colinas, August 17-21.";
    expect(validateEntities(answer, ROSTER, grounding)).toBeNull();
  });

  it("flags the same venue when nothing retrieved mentions it", () => {
    const answer = "The training was held at the Ritz Carlton Las Colinas in August.";
    const flag = validateEntities(answer, ROSTER, "");
    expect(flag).not.toBeNull();
    expect(flag?.reason ?? "").toMatch(/Ritz Carlton/);
  });

  /* THE FAILURE THIS CHECK EXISTS FOR, and the reason the earlier attempt at
     a general rule was reverted. Inventing a colleague must still be caught,
     and Mortimer appears in no chunk. */
  it("still catches an invented colleague", () => {
    const flag = validateEntities(
      "Mortimer joined the deal last week.",
      ROSTER,
      "The Greenfield account moved to stage three after a call with Jorge.",
    );
    expect(flag).not.toBeNull();
    expect(flag?.reason ?? "").toMatch(/Mortimer/);
  });

  /* Corroboration is about what was read, not about how it was capitalised. */
  it("matches regardless of case", () => {
    expect(
      validateEntities("The Hilton Hotel hosted it.", ROSTER, "held at the hilton hotel"),
    ).toBeNull();
  });

  it("is unchanged when there is no grounding to check against", () => {
    expect(validateEntities("Ready when you are.", ROSTER)).toBeNull();
  });

  /* THE SENTENCE-OPENER CLASS, WHICH THIS ALSO HELPS WITH, and I only found
     out by writing the test.
     "Sessions were held there" reports Sessions when there is nothing to check
     against, because the word is neither on the roster nor on the closed list
     #271 extended. It is corroborated the moment the material contains it,
     which for an answer written FROM that material is the ordinary case. So
     grounding narrows this class too, rather than only the proper-noun one. */
  it("also corroborates an ordinary noun that opens a sentence", () => {
    expect(validateEntities("Sessions were held there.", ROSTER, "")).not.toBeNull();
    expect(
      validateEntities("Sessions were held there.", ROSTER, "sessions were held"),
    ).toBeNull();
  });
});

/* ---------------------------------------------------------------------
 * A confident answer about US, built from nothing.
 *
 * gateConfidence returns null at zero hits on purpose: with no retrieval the
 * answer is general knowledge, and gating it killed "what is Nurburgring" when
 * that was tried in May. Right about the world, wrong about us.
 *
 * Measured by typing invented terms at the deployed assistant:
 *   "WolfpackxPCNA"             -> "the integration between the Wolfpack
 *                                   platform and Porsche Cars North America"
 *   "our Q4 Falcon initiative"  -> "enhancing the Falcon lead distribution
 *                                   engine, optimizing lead routing"
 *
 * WolfpackxPCNA is a SharePoint folder. Falcon does not exist. Both were
 * fluent, specific and delivered at full confidence.
 *
 * Worse than a wrong retrieval, because there is nothing to check it against:
 * a wrong document can be opened and disagreed with, an invented process
 * cannot. In front of a dealer asking about a warranty procedure it is
 * indefensible.
 * --------------------------------------------------------------- */
describe("questions about us cannot be answered from nothing", () => {
  it.each([
    "what is our Q4 Falcon initiative",
    "WolfpackxPCNA",
    "what does our escalation process look like",
    "how do we handle warranty claims",
    "what is the company's travel policy",
  ])("%s is blocked with no retrieval behind it", (q) => {
    expect(gateUngroundedClaimAboutUs(q, 0)).not.toBeNull();
  });

  /* THE MAY REGRESSION THIS MUST NOT REPEAT. The world is still answerable. */
  it.each([
    "what is Nurburgring",
    "what is a VIN",
    "who was Ferdinand Porsche",
    "what does horsepower mean",
  ])("%s still answers", (q) => {
    expect(gateUngroundedClaimAboutUs(q, 0)).toBeNull();
  });

  /* With a source behind it, an internal question is exactly what the product
     is for. The gate is about absence of grounding, not about the subject. */
  it("allows an internal question when something was retrieved", () => {
    expect(gateUngroundedClaimAboutUs("what is our travel policy", 3)).toBeNull();
  });

  /* KNOWN LIMIT, RECORDED. A question naming no company reads as general
     knowledge, so an invented external-sounding term still gets a
     general-knowledge answer: "what is the Zentrala protocol" is answered.
     Widening to any unknown proper noun would take Nurburgring with it, which
     is the regression this gate is careful not to repeat. The real remedy is
     grounding: with the library loaded, the answer comes from a document or
     says there is none. */
  it("does not catch an invented term that names no organisation", () => {
    expect(gateUngroundedClaimAboutUs("what is the Zentrala protocol", 0)).toBeNull();
  });
});

/* ---------------------------------------------------------------------
 * A long list is evidence the CHECK failed, not the answer.
 *
 * Measured on a real answer about registering a demo vehicle:
 *   "16 unfamiliar name(s): Navigate, Inventory Management, Inventory"
 *
 * A verb and two UI labels. A model does not invent sixteen people in one
 * paragraph; a capitalisation heuristic run over a formatted answer finds
 * sixteen capitalised things, which is a different fact.
 *
 * Warning anyway is worse than silence: a list of sixteen teaches people to
 * dismiss the hedge, which then gets dismissed on the answer that really did
 * invent a colleague. An unreliable warning spends the credibility of the
 * reliable one.
 * --------------------------------------------------------------- */
describe("when the entity check finds implausibly many names", () => {
  const ROSTER = ["jorge colon"];

  it("stays quiet rather than crying wolf", () => {
    const formatted = [
      "1. **Navigate to Inventory Management**",
      "2. **Add Vehicle**: Click Add Vehicle",
      "3. **Enter Vehicle Details**: VIN, Make, Model, Year",
      "4. **Assign to Dealer**: Optionally assign",
      "5. **Save Vehicle**: Click Save or Submit",
      "6. **Verify**: Check Demo Vehicles in Inventory",
    ].join("\n");
    expect(validateEntities(formatted, ROSTER)).toBeNull();
  });

  /* THE ONE IT EXISTS FOR still fires. A fabrication names one or two people,
     which is why the threshold is generous rather than tight. */
  it("still flags a single invented colleague", () => {
    const flag = validateEntities("Mortimer joined the deal last week.", ROSTER);
    expect(flag).not.toBeNull();
    expect(flag?.reason ?? "").toMatch(/Mortimer/);
  });

  it("still flags a small handful", () => {
    expect(
      validateEntities("Mortimer and Fenwick reviewed it together.", ROSTER),
    ).not.toBeNull();
  });
});

/* ---------------------------------------------------------------------
 * The tell is not always in the question.
 *
 * "How do I register a demo vehicle" names nobody, so the gate stayed quiet -
 * and the reply was a six-step walkthrough of screens in wolfpack-auto that do
 * not exist: Navigate to Inventory Management, click Add Vehicle, set Vehicle
 * Status to Demo. Fluent, numbered and invented, and a dealer following those
 * steps is the concrete harm.
 * --------------------------------------------------------------- */
describe("an answer that describes us with nothing behind it", () => {
  const WALKTHROUGH =
    "To register a demo vehicle in the wolfpack-auto platform: navigate to Inventory Management and click Add Vehicle.";

  it("is blocked even when the question named nobody", () => {
    expect(
      gateUngroundedClaimAboutUs("how do I register a demo vehicle", 0, WALKTHROUGH),
    ).not.toBeNull();
  });

  it("is allowed when something was actually retrieved", () => {
    expect(
      gateUngroundedClaimAboutUs("how do I register a demo vehicle", 3, WALKTHROUGH),
    ).toBeNull();
  });

  /* The world is still answerable, which is the regression this whole gate is
     careful not to repeat. */
  it("leaves an answer about the world alone", () => {
    expect(
      gateUngroundedClaimAboutUs(
        "what is a VIN",
        0,
        "A VIN is a seventeen character identifier assigned to a vehicle by its manufacturer.",
      ),
    ).toBeNull();
  });
});

/**
 * One constant was being applied to two different measurements.
 *
 * topScore is max() over hits from two indexes. Semantic scores are cosine
 * similarity, measured to separate at 0.36. Keyword scores are ts_rank_cd,
 * where a real question about time-off policy scored 0.0404 and the word "yes"
 * scored 0.5000, because the number tracks query length rather than relevance.
 *
 * Both were compared against 0.55, a constant with no derivation that predates
 * semantic retrieval being switched on.
 *
 * Measured on production 2026-08-27: of 55 recorded Brain retrievals, 52
 * scored between 0.36 and 0.54. Each one found a real document, paid for a
 * model call, and had the answer replaced with "I don't have a confident
 * answer for that". Three ever cleared 0.55.
 */
describe("the confidence gate judges each scale against its own floor", () => {
  const FLOOR = 0.36;

  /* The exact band that was being thrown away. */
  it.each([0.36, 0.38, 0.41, 0.44, 0.46, 0.51, 0.53, 0.54])(
    "keeps a semantic answer scoring %s, which the index already accepted",
    (score) => {
      expect(gateConfidence(score, 3, true, FLOOR)).toBeNull();
    },
  );

  it("still blocks a semantic score below the floor the index enforced", () => {
    const flag = gateConfidence(0.2, 3, true, FLOOR);
    expect(flag?.severity).toBe("block");
    expect(flag?.reason).toMatch(/semantic/);
  });

  /* ts_rank_cd is not on the cosine scale, so no cosine threshold applies.
     Keyword relevance is held upstream by the subject-word test and by
     judgeRelevance reading the material. */
  it("applies no cosine threshold to a keyword score", () => {
    expect(gateConfidence(0.0404, 3, false, FLOOR)).toBeNull();
    expect(gateConfidence(0.5, 3, false, FLOOR)).toBeNull();
  });

  /* An unaware caller must not be silently ungated. */
  it("falls back to the conservative threshold when the scale is not stated", () => {
    expect(gateConfidence(0.44, 3, undefined, FLOOR)?.severity).toBe("block");
    expect(gateConfidence(0.9, 3, undefined, FLOOR)).toBeNull();
  });

  it("still ignores an answer with no retrieval behind it at all", () => {
    expect(gateConfidence(0, 0, true, FLOOR)).toBeNull();
    expect(gateConfidence(undefined, 3, true, FLOOR)).toBeNull();
  });

  /* Belt and braces only works while the floor is actually supplied. */
  it("does not invent a floor when none was passed", () => {
    expect(gateConfidence(0.1, 3, true, undefined)).toBeNull();
  });
});

/**
 * An answer that talks ABOUT an answer instead of being one.
 *
 * Found by driving the deployed product as a user, 2026-08-29. Asking for a
 * "coaching calls spreadsheet" returned a critique of a draft the reader never
 * saw, prefixed with a warning that the answer "mentions 1 unfamiliar name:
 * Corrected" — the entities filter having taken the word "Corrected" for a
 * person.
 *
 * So the reader got meta-commentary, wrapped in an alarming and incorrect
 * note. Nothing else caught the commentary itself: it is fluent, on topic,
 * long enough to pass every length check, and grounded in nothing at all.
 */
describe("meta-commentary is blocked, not hedged", () => {
  /* VERBATIM from production. */
  it("catches the answer that shipped", () => {
    const flag = gateMetaCommentary(
      "The question asks for a coaching calls spreadsheet, but the draft does not address whether one exists, provide any relevant information, or summarize data that might have been retrieved.",
    );
    expect(flag).not.toBeNull();
    expect(flag!.filter).toBe("meta_commentary");
  });

  /* BLOCK, not warn, and that is the whole point. Every other filter hedges an
     answer that might still help. This one has nothing to hedge: an answer
     about "the draft" carries no content for the person who asked, so a
     warning label on it is worse than the deterministic fallback, which at
     least offers something they can ask instead. */
  it("blocks rather than warns, so the reader gets the fallback", () => {
    expect(gateMetaCommentary("The draft answer fails to mention the payment terms.")!.severity).toBe(
      "block",
    );
  });

  it.each([
    "The draft answer fails to mention the payment terms.",
    "The answer should include the invoice total.",
    "This response does not address the question asked.",
  ])("catches %s", (answer) => {
    expect(gateMetaCommentary(answer)).not.toBeNull();
  });

  /* NARROW ON PURPOSE. The words "answer", "question" and "draft" appear in
     plenty of legitimate replies, and a filter that fired on those would block
     correct answers, which is far worse than the defect it fixes. The last
     case is the trap: it mentions a draft document, not a draft answer. */
  it.each([
    "The answer is net 30 from the invoice date.",
    "Here is the answer to your question about payment terms.",
    "The question of scope is covered in section 3 of the SOW.",
    "Final payment is due within 30 days of configuration.",
    "I could not find that. The draft SOW is in Docs if you want to look.",
  ])("leaves a real answer alone: %s", (answer) => {
    expect(gateMetaCommentary(answer)).toBeNull();
  });

  it("is quiet on an empty answer, which other filters already handle", () => {
    expect(gateMetaCommentary("")).toBeNull();
  });

  /* It must reach `reject`, or the fix stops at the flag and the reader still
     sees the commentary with a note on top. */
  it("drives the overall verdict to reject", () => {
    const result = runAnswerQualityChecks(
      {
        /* Deliberately high score and hit count: this must reject on the
           commentary alone, not because retrieval was weak. In production it
           arrived alongside real hits. */
        answer:
          "The question asks for a coaching calls spreadsheet, but the draft does not address whether one exists.",
        topScore: 0.9,
        hitCount: 3,
      },
      { userId: "u1", userRole: "cto" },
    );
    expect(result.verdict).toBe("reject");
    expect(result.flags.map((f) => f.filter)).toContain("meta_commentary");
  });
});
