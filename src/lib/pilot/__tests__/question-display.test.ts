/**
 * The real entries that were on the client page, asserted.
 *
 * Every string below was rendered verbatim on /pilot before this existed. They
 * are kept as the test cases because a synthetic example would not have caught
 * any of them: the paste was long in a way no fixture is, the name was
 * lowercase so no capitalisation rule would have seen it, and the remark
 * opened like ordinary prose.
 */

import { forDisplay, isAnswerable, MAX_CHARS } from "@/lib/pilot/question-display";
import { buildNameList } from "@/lib/pilot/known-names";

const KNOWN = buildNameList(["Nick Homyk", "Dana Ruiz", "Smith, John Paul", "Amy Cole (Contractor)"]);

describe("what may be shown on a client's dashboard", () => {
  it("shows an ordinary question as it was asked", () => {
    const d = forDisplay("how do i submit a warranty claim?", KNOWN);
    expect(d).toEqual({ text: "how do i submit a warranty claim?" });
  });

  /* THE ENTRY THAT BROKE THE PAGE. 1,400 characters of pasted claim notes,
     the same sentence fourteen times, longer than every other section. */
  it("keeps the topic of a paste and drops the passage", () => {
    const paste =
      "summarize the single most common failure in these claim notes in one sentence. " +
      "the dealer submitted a warranty claim for a cayenne with an intermittent fault reported at 42,110 miles and the technician replaced the sensor harness. ".repeat(
        14,
      );

    const d = forDisplay(paste, KNOWN);
    expect(d?.withheld).toBe("paste");
    expect(d!.text.length).toBeLessThanOrEqual(MAX_CHARS);
    /* The instruction survives, which is the only part that was ever a gap. */
    expect(d!.text).toMatch(/summarize the single most common failure/);
    expect(d!.text).not.toMatch(/sensor harness/);
  });

  it("never returns more than the maximum, whatever arrives", () => {
    for (const raw of ["what is " + "x".repeat(4000), "list " + "a b ".repeat(500)]) {
      expect(forDisplay(raw, KNOWN)!.text.length).toBeLessThanOrEqual(MAX_CHARS);
    }
  });

  /* A NAME IS A SIGNAL, NOT A LINE OF TEXT. Somebody searching for a person
     says the directory is not connected. Publishing who they looked for adds
     nothing to that. */
  it("reports a bare name search without the name", () => {
    const d = forDisplay("john paul smith", KNOWN);
    expect(d).toEqual({ text: "a person's name", withheld: "name" });
  });

  it("masks a colleague named inside a request", () => {
    const d = forDisplay("send this potential change to nick homyk", KNOWN);
    expect(d?.withheld).toBe("name");
    expect(d!.text).not.toMatch(/homyk|nick/i);
    /* The request itself still reads, because that is the gap. */
    expect(d!.text).toMatch(/send this potential change to a colleague/);
  });

  it("masks a first name used on its own", () => {
    const d = forDisplay("book me 30 minutes with dana tomorrow", KNOWN);
    expect(d!.text).not.toMatch(/dana/i);
    expect(d!.text).toMatch(/book me 30 minutes with a colleague tomorrow/);
  });

  /* NOT A GAP AND NEVER WAS. There is no document whose absence caused it, so
     listing it under "what we could not answer" is a category error, and
     forwarding it to a client is worse than that. */
  it("withholds a remark about the product", () => {
    expect(forDisplay("this platform still sucks", KNOWN)).toBeNull();
  });

  it("withholds a bug report written as a statement", () => {
    expect(
      forDisplay("this attachment wont send unless i typer into the field btw", KNOWN),
    ).toBeNull();
  });

  it("keeps a complaint that is genuinely a question", () => {
    /* The distinction is the question, not the tone. Dropping anything that
       sounded negative would delete real demand. */
    expect(forDisplay("why is this platform so slow?", KNOWN)?.text).toBe(
      "why is this platform so slow?",
    );
  });

  it("redacts a card number before anything else looks at the text", () => {
    const d = forDisplay("is 4111 1111 1111 1111 the card on file?", KNOWN);
    expect(d!.text).not.toMatch(/4111/);
  });

  it("reads an opener through a leading bullet", () => {
    const d = forDisplay("- synthesize a cross-source pre-brief for the next meeting", KNOWN);
    expect(d?.text).toMatch(/^synthesize a cross-source pre-brief/);
  });

  it("works with no directory at all", () => {
    /* The list is empty whenever the directory cannot be read, and the panel
       still has to be safe: shortening and the statement rule do not depend
       on it. */
    expect(forDisplay("this platform still sucks", [])).toBeNull();
    expect(forDisplay("what is " + "x".repeat(500), [])!.text.length).toBeLessThanOrEqual(MAX_CHARS);
  });

  it("treats a question mark as settling it", () => {
    expect(isAnswerable("the sow terms?")).toBe(true);
    expect(isAnswerable("the sow terms")).toBe(false);
  });
});

describe("the name list", () => {
  it("puts longer names first so a full name is never left half-masked", () => {
    const list = buildNameList(["Nick Homyk"]);
    expect(list[0]).toBe("nick homyk");
    expect(list).toContain("homyk");
  });

  it("unwraps the shapes a directory actually stores", () => {
    expect(buildNameList(["Smith, John Paul"])).toContain("smith john paul");
    expect(buildNameList(["Amy Cole (Contractor)"])).toContain("amy cole");
  });

  /* A three-letter first name doubling as a word would mask "same day" and
     "and then", which breaks more than it protects. */
  it("leaves short first names out", () => {
    expect(buildNameList(["Sam Vale"])).not.toContain("sam");
    expect(buildNameList(["Sam Vale"])).toContain("vale");
  });
});
