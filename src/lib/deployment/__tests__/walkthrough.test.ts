/**
 * Does the product do what we have written down that it does?
 *
 * Every fixture is an answer this deployment actually returned on 2026-08-31,
 * gathered while checking whether the client guide was safe to demo.
 */
import { judge, assessWalkthrough, describeReadiness, type PromisedPrompt, type ObservedAnswer } from "../walkthrough";

const p = (over: Partial<PromisedPrompt> = {}): PromisedPrompt => ({
  id: "documents.ask",
  prompt: "what does our policy say about time off?",
  returns: "synthesised",
  because: "The answer, in prose, with the document it came from.",
  ...over,
});

const a = (over: Partial<ObservedAnswer> = {}): ObservedAnswer => ({
  text: "Net 30 from invoice date, with a 2% discount inside 10 days.",
  source: "brain",
  widgetRows: 0,
  sources: 3,
  ms: 800,
  ...over,
});

describe("the two failures that must not be confused", () => {
  /* THE PRODUCT SAID HONESTLY THAT IT HOLDS NOTHING. Reporting this as a
     defect sends somebody debugging retrieval when the fix is to pick a
     document the client actually has. */
  it("calls an honest miss a demo problem, not a defect", () => {
    const v = judge(
      p(),
      a({ text: "I could not find a clear answer to that. The closest things I hold are:", sources: 0 }),
    );
    expect(v.state).toBe("nothing-to-answer-with");
  });

  /* THE GUIDE IS LYING. It promised a written answer and the product ran a
     search. */
  it("calls a count returned for a promised answer a defect", () => {
    const v = judge(p(), a({ text: 'Found 4 results for "onboarding": 1 knowledge entry, 3 documents.' }));
    expect(v.state).toBe("wrong-shape");
    expect(v.state === "wrong-shape" && v.why).toMatch(/returned a result count/);
  });

  it("does not let a miss and a defect land in the same bucket", () => {
    const r = assessWalkthrough([
      judge(p(), a({ text: "I could not find a clear answer to that.", sources: 0 })),
      judge(p(), a({ text: "Found 4 results for x." })),
    ]);
    expect(r.nothingToAnswerWith).toHaveLength(1);
    expect(r.wrongShape).toHaveLength(1);
  });
});

describe("a promised list", () => {
  const find = p({ id: "documents.find", returns: "list", prompt: "what documents do we have about onboarding?" });

  /* THE CORRECTION I HAD TO MAKE. The transcript prints only text, so a count
     LOOKED like a failure. In the UI the rows are in the widget, and the
     contract is honoured. */
  it("accepts a count sentence when rows sit behind it", () => {
    const observed = a({ text: 'Found 4 results for "onboarding".', widgetRows: 4, sources: 4 });
    expect(judge(find, observed).state).toBe("delivers");
  });

  it("refuses a count with nothing behind it", () => {
    const v = judge(find, a({ text: "Found 4 results.", widgetRows: 0, sources: 0 }));
    expect(v.state).toBe("wrong-shape");
    expect(v.state === "wrong-shape" && v.why).toMatch(/nothing behind it/);
  });
});

describe("a promised written answer", () => {
  it("accepts prose that cites its document", () => {
    expect(judge(p(), a()).state).toBe("delivers");
  });

  /* The shape this product exists to avoid: an answer that reads as grounded
     and is not. */
  it("refuses prose that cites nothing", () => {
    const v = judge(p(), a({ sources: 0, source: "brain" }));
    expect(v.state).toBe("wrong-shape");
    expect(v.state === "wrong-shape" && v.why).toMatch(/cited nothing/);
  });

  /* A model answering from its own knowledge is a different thing and says so
     in its source, so it is not held to the citation rule here. */
  it("allows a model answer to stand on its own attribution", () => {
    expect(judge(p(), a({ sources: 0, source: "ai" })).state).toBe("delivers");
  });
});

describe("what it refuses to claim", () => {
  /* A confident wrong answer passes this check. Saying so keeps somebody from
     reading a green run as "the answers are correct". */
  it("judges shape and never correctness", () => {
    const wrongButWellShaped = judge(p(), a({ text: "Time off is unlimited.", sources: 2 }));
    expect(wrongButWellShaped.state).toBe("delivers");
  });

  it("does not call the contract broken because a corpus is thin", () => {
    const r = assessWalkthrough([
      judge(p(), a({ text: "I could not find a clear answer to that.", sources: 0 })),
    ]);
    expect(r.contractHolds).toBe(true);
    expect(describeReadiness(r)).toMatch(/product is fine/);
  });

  it("calls the contract broken when a promise is not kept", () => {
    const r = assessWalkthrough([judge(p(), a({ text: "Found 2 results." }))]);
    expect(r.contractHolds).toBe(false);
    expect(describeReadiness(r)).toMatch(/does NOT hold/);
  });
});
