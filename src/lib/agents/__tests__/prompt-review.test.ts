/**
 * The reviewer is only useful if it can say nothing is wrong.
 *
 * Every writing checker drifts toward firing on everything, at which point it is
 * noise and a careful brief scores the same as a careless one. Half of these
 * tests exist to hold that line, and one of them uses a real brief taken from
 * this project's own history rather than a sentence written to pass.
 */
import { reviewPrompt, type Dimension } from "../prompt-review";

const dims = (text: string): Dimension[] => reviewPrompt(text).findings.map((f) => f.dimension);

describe("it can say nothing is wrong", () => {
  it("finds nothing in a brief that carries every fact", () => {
    const good = `Add a Test each model button to /admin/ai-router in wolfpack-apex.
      Reuse the existing MODEL_REGISTRY rather than a new list. It must work on
      https://wolfpack-instinct.vercel.app, and I will accept it when clicking the
      button names any model that does not answer. Do not change the router's
      selection logic. Ship it as a PR. The Azure keys are already set in Vercel.`;
    expect(reviewPrompt(good).findings).toEqual([]);
    expect(reviewPrompt(good).headline).toMatch(/nothing to add/i);
  });

  it("leaves a clean brief exactly as written", () => {
    const good = `Fix the login button on https://example.com/admin. Reuse the existing
      hydration gate in app/login/page.tsx. Do not touch the public site. Verify by
      clicking Sign in before the page finishes loading. Open a PR. No new credentials needed.`;
    expect(reviewPrompt(good).suggested).toBe(good.trim());
  });

  it("has nothing to say about an empty brief, rather than everything", () => {
    // Seven findings on an empty string would be technically true and useless.
    expect(reviewPrompt("   ").findings).toEqual([]);
    expect(reviewPrompt("   ").headline).toMatch(/nothing to review/i);
  });
});

describe("it names the fact that is missing, one at a time", () => {
  const BARE = "Make the dashboard better";

  it.each<[Dimension, string]>([
    ["done-condition", "how you would know it worked"],
    ["environment", "where it has to work"],
    ["scope-boundary", "what must not change"],
    ["reuse", "what already exists"],
  ])("flags %s on a bare brief", (dimension) => {
    expect(dims(BARE)).toContain(dimension);
  });

  it("stops flagging a dimension once the brief supplies it", () => {
    // The test that proves the detectors detect rather than always fire.
    expect(dims(BARE)).toContain("environment");
    expect(dims(`${BARE} on https://wolfpack-instinct.vercel.app`)).not.toContain("environment");

    expect(dims(BARE)).toContain("done-condition");
    expect(dims(`${BARE}. I will verify by opening it.`)).not.toContain("done-condition");

    expect(dims(BARE)).toContain("scope-boundary");
    expect(dims(`${BARE}, but do not touch the nav.`)).not.toContain("scope-boundary");
  });
});

describe("sequencing is only asked of a brief that has several parts", () => {
  it("does not ask a one-line brief how to order itself", () => {
    // Asking a single ask about its ordering is the checker inventing work.
    expect(dims("Fix the login button")).not.toContain("sequencing");
  });

  it("does not treat a carefully-described single task as multi-part", () => {
    // The regression that produced this test: a sentence-count heuristic flagged
    // the one brief in the suite that needed no help, purely for being detailed.
    // A reviewer that penalises detail teaches people to write less.
    const detailed = `Add a probe to /admin/ai-router. It should send a one-token
      request to each configured model. It must not change selection logic. I will
      accept it when a broken deployment is named on screen. Ship it as a PR.`;
    expect(dims(detailed)).not.toContain("sequencing");
  });

  it("asks a multi-part brief", () => {
    const many = `Verify each model can be triggered.
      Also check whether the admin site is production ready.
      Additionally update the release notes.`;
    expect(dims(many)).toContain("sequencing");
  });

  it("does not ask a multi-part brief that already says the order", () => {
    const ordered = `First verify each model can be triggered.
      Once complete, check whether the admin site is production ready.
      Then update the release notes.`;
    expect(dims(ordered)).not.toContain("sequencing");
  });
});

describe("who decides, asked only where a decision is likely", () => {
  // Added after a real loop. A check stayed red because the font cut is a brand
  // decision that changes public-site typography, and three rounds went into
  // treating it as a defect. blocking-input is about a credential, which is a
  // thing to FETCH; this is about authority, which is a thing to ASK FOR.
  it("asks a brief that touches design or brand", () => {
    expect(dims("Get the admin design matching the prototype")).toContain("decision-owner");
    expect(dims("Pick a font for the client site")).toContain("decision-owner");
  });

  it("asks a brief that touches money or a client commitment", () => {
    expect(dims("Work out the pricing for this client")).toContain("decision-owner");
  });

  it("does NOT ask a purely mechanical brief", () => {
    // "Fix the failing test" has no decision in it. Asking would be the
    // checker inventing work, which is the failure mode it exists to avoid.
    expect(dims("Fix the failing test in src/lib/db.ts")).not.toContain("decision-owner");
    expect(dims("Bump the timeout in the e2e helper to 45 seconds")).not.toContain("decision-owner");
  });

  it("stops asking once the brief says what to do at a judgment", () => {
    expect(dims("Get the admin design matching the prototype. Stop and ask me if a brand choice comes up.")).not.toContain(
      "decision-owner",
    );
    expect(dims("Get the admin design matching the prototype, proceed on a stated assumption if unsure.")).not.toContain(
      "decision-owner",
    );
  });
});

describe("when to come back, asked only where several attempts are likely", () => {
  // Added after a session that ran past twenty exchanges. There WAS a
  // done-condition and it still went badly, because the brief never said
  // whether to surface partial states. Every partial report read as a claim of
  // completion, so real progress felt like repeated failure.
  it("asks a brief about something already failing", () => {
    expect(dims("The spec check is failing, please fix it")).toContain("reporting-cadence");
    expect(dims("CI is red again")).toContain("reporting-cadence");
  });

  it("does NOT ask a one-shot brief that merely says how it will be verified", () => {
    // The first version triggered on "test" and "verify", which flagged every
    // well-written brief. Keying on verification punishes the habit worth
    // having.
    expect(dims("Add a probe to /admin/ai-router. Verify by pressing the button.")).not.toContain("reporting-cadence");
    expect(dims("Fix the login button and test it")).not.toContain("reporting-cadence");
  });

  it("stops asking once the brief says when to come back", () => {
    expect(dims("The check is failing. Only come back when everything passes.")).not.toContain("reporting-cadence");
    expect(dims("CI is red, fix it, and check in at each step.")).not.toContain("reporting-cadence");
  });
});

describe("what it hands back", () => {
  it("appends questions instead of rewriting the brief", () => {
    // Rewriting would mean inventing the answers, and a confident wrong
    // assumption written back in the operator's own voice is worse than the gap.
    const review = reviewPrompt("Make the dashboard better");
    expect(review.suggested.startsWith("Make the dashboard better")).toBe(true);
    for (const f of review.findings) expect(review.suggested).toContain(f.ask);
  });

  it("gives every finding a question and a concrete cost, not a scolding", () => {
    for (const f of reviewPrompt("Make the dashboard better").findings) {
      // Contains a question, not ends with one: several asks legitimately add a
      // clarifying sentence after the question ("...? Name the screen."). The
      // property worth holding is that it ASKS rather than instructs.
      expect(f.ask).toContain("?");
      expect(f.cost.length).toBeGreaterThan(30);
      expect(f.ask + f.cost).not.toMatch(/\b(vague|lazy|poor|bad|unclear brief|you should have)\b/i);
    }
  });

  it("says how many things the work would otherwise guess at", () => {
    expect(reviewPrompt("Make the dashboard better").headline).toMatch(/guess at/i);
  });
});
