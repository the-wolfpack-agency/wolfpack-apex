/**
 * The two entries the directory mask could not reach, asserted gone.
 *
 * Both were on the live page. Neither the colleague nor the client appears in
 * any table this workspace holds, so no amount of masking would have caught
 * them, which is the whole reason this bucket stopped rendering free text.
 */

import { actionOf, summarizeWanted } from "@/lib/pilot/wanted-actions";

describe("what people wanted done", () => {
  it("names the action and never the person", () => {
    const { actions } = summarizeWanted([{ query: "book me 30 minutes with dana tomorrow", asked: 1 }], 3);
    expect(actions).toEqual([{ action: "schedule a meeting", asked: 1 }]);
    expect(JSON.stringify(actions)).not.toMatch(/dana/i);
  });

  it("names the action and never the client", () => {
    const { actions } = summarizeWanted(
      [{ query: "collect out rubycar marketing emails into one folder", asked: 1 }],
      3,
    );
    expect(actions).toEqual([{ action: "file or move email", asked: 1 }]);
    expect(JSON.stringify(actions)).not.toMatch(/rubycar/i);
  });

  it("adds up different phrasings of the same want", () => {
    const { actions } = summarizeWanted(
      [
        { query: "book me 30 minutes with a colleague", asked: 2 },
        { query: "schedule a review for friday", asked: 3 },
        { query: "set up a call about the renewal", asked: 1 },
      ],
      3,
    );
    /* Three sentences, one thing people want. That is the fact worth putting
       on the page, and quoting all three would have hidden it. */
    expect(actions).toEqual([{ action: "schedule a meeting", asked: 6 }]);
  });

  it("reads a two-word verb before the single word inside it", () => {
    expect(actionOf("set up a call")).toBe("schedule a meeting");
    expect(actionOf("turn off notifications")).toBe("change a setting");
  });

  it("counts an unrecognized instruction rather than dropping it", () => {
    const s = summarizeWanted([{ query: "escalate this to legal", asked: 4 }], 3);
    expect(s.actions).toEqual([]);
    /* Silence here would read as nobody having wanted anything, and this
       bucket exists because people do not file requests for what they assume
       already works. */
    expect(s.other).toBe(4);
  });

  it("never reads a verb from the middle of a sentence", () => {
    /* "send" appears, but the instruction is about a document. Matching
       anywhere would let the object of one verb become the label of another. */
    expect(actionOf("the report i send every friday")).toBeNull();
  });

  it("reads a verb through a leading bullet", () => {
    expect(actionOf("- assign this to the duty manager")).toBe("assign work to someone");
  });

  it("returns nothing for an empty log", () => {
    expect(summarizeWanted([], 3)).toEqual({ actions: [], other: 0 });
  });
});
