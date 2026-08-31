/**
 * Each rule, against the bad pair it was written for.
 *
 * Every case below is a real one from this corpus. A rule tested only on
 * invented examples passes while missing the thing it was built to catch, and
 * two of these rules reported catching nothing on runs where nothing happened
 * to trigger them.
 */

import {
  namesTheFile,
  familyStem,
  questionOverlap,
  collidingPairs,
  COLLISION,
} from "@/lib/brain/eval/pair-quality";

describe("a question that restates its filename", () => {
  /* 52 citations, the most-cited candidate the harvester ever produced, and
     retrieval cannot fail it. */
  it("catches the McDonalds pair", () => {
    expect(namesTheFile("Meeting Notes with McDonalds", "Meeting Notes with McDonalds")).toBe(true);
  });

  it("allows a real question about the same document", () => {
    expect(
      namesTheFile("what did we agree about the rollout timeline", "Meeting Notes with McDonalds"),
    ).toBe(false);
  });

  it("is not fooled by the file extension", () => {
    expect(namesTheFile("what is the towing capacity", "Cayenne Comp Graphics.pdf")).toBe(false);
  });
});

describe("documents that are re-runs of each other", () => {
  /* Ten cohort exports, same columns, same questions, different hotel and
     week. Any of them answers a question about survey feedback. */
  it("groups the survey exports", () => {
    expect(familyStem("Survey Data PCBA 101 Conrad_May 11-15.xlsx")).toBe(
      familyStem("Survey Data PCBA_WO 8.10-8.17_All.xlsx"),
    );
    expect(familyStem("Survey Data PCBA_102_Ritz Carlton Las Colinas Aug 17-21.xlsx")).toBe(
      familyStem("Survey Data PCBA 101 Westlake_May 18-22.xlsx"),
    );
  });

  /* THE OVER-CORRECTION, ASSERTED. Stripping every number made a course's
     first and third days siblings and threw out 30 of 46 documents to catch
     10 real duplicates. */
  it("keeps different days of a course apart", () => {
    expect(familyStem("BA101_Day 1_MLG_V8_4-20-26.pdf")).not.toBe(
      familyStem("BA101_Day 3_MLG_V8_4-21-26.pdf"),
    );
  });

  it("keeps different courses apart", () => {
    expect(familyStem("BA101_Day 1_MLG_V8_4-20-26.pdf")).not.toBe(
      familyStem("BA102_Day 1_MLG_V8_4-20-26.pdf"),
    );
  });
});

describe("two questions about the same thing", () => {
  /* Both courses close with the same activity, so two guides produced nearly
     the same question naming different files. Whichever the retriever finds,
     one pair marks it wrong. */
  const shared = [
    {
      question: "What activity involves participants writing a congratulatory note to themselves?",
      expectFilename: "BA102_Day 4_MLG_V8_4-21-26.pdf",
    },
    {
      question: "What activity involves writing a self-congratulatory note for future reflection?",
      expectFilename: "BA101_Day 4_MLG_V8_4-21-26.pdf",
    },
  ];

  it("scores the shared-activity questions as a collision", () => {
    expect(questionOverlap(shared[0].question, shared[1].question)).toBeGreaterThanOrEqual(
      COLLISION,
    );
  });

  it("drops both, because neither course owns an activity they share", () => {
    expect(collidingPairs(shared)).toEqual(new Set([0, 1]));
  });

  it("leaves unrelated questions alone", () => {
    const fine = [
      { question: "What is the towing capacity of the Cayenne Electric?", expectFilename: "a.pdf" },
      { question: "What is the individual deductible for the Silver plan?", expectFilename: "b.pdf" },
    ];
    expect(collidingPairs(fine).size).toBe(0);
  });

  /* Two questions about the SAME document are not ambiguous, they are two
     questions about one document, which is fine. */
  it("does not collide two questions that name the same file", () => {
    const same = [
      { question: "What activity involves writing a congratulatory note?", expectFilename: "x.pdf" },
      { question: "What activity involves writing a congratulatory letter?", expectFilename: "x.pdf" },
    ];
    expect(collidingPairs(same).size).toBe(0);
  });

  /* The stopword list is the whole rule. Over-listing makes everything overlap
     with everything and silently drops the entire set. */
  it("does not treat every question as alike", () => {
    expect(
      questionOverlap(
        "What happens if the Client breaches a material obligation?",
        "What are the features of the Porsche Mobile Academy?",
      ),
    ).toBeLessThan(COLLISION);
  });
});
