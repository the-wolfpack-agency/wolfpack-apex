/**
 * Making an agent comprehensible without making it look safe.
 *
 * Personification is the point and the danger. A friendly card on an ungoverned
 * agent is worse than a wall of JSON, because JSON does not reassure anyone.
 * Most of these tests exist to stop the card from implying more than the
 * evidence supports.
 */
import {
  describeCapabilities,
  describeModel,
  describeState,
  hueFor,
  initialsFor,
  trustLine,
} from "../persona";

describe("the avatar identifies, it does not endorse", () => {
  it("is stable for the same agent", () => {
    // The same agent must look the same everywhere, or the visual identity is
    // worse than none.
    expect(hueFor("agent-1")).toBe(hueFor("agent-1"));
    expect(initialsFor("Research Scout")).toBe("RS");
  });

  it("is derived from the id, so a rename does not change who you are looking at", () => {
    expect(hueFor("agent-1")).not.toBe(hueFor("agent-2"));
  });

  it("never lands in the red band, which is reserved for misbehavior", () => {
    // A red agent must be red because it did something, not because its id
    // hashed that way. Otherwise the color stops carrying meaning at exactly
    // the moment it matters.
    for (let i = 0; i < 500; i++) {
      const hue = hueFor(`agent-${i}`);
      expect(hue).toBeGreaterThanOrEqual(30);
      expect(hue).toBeLessThan(330);
    }
  });

  it("handles a name it cannot make initials from", () => {
    expect(initialsFor("")).toBe("??");
    expect(initialsFor("   ")).toBe("??");
    expect(initialsFor("Scout")).toBe("SC");
    expect(initialsFor("data-sync-bot")).toBe("DB");
  });
});

describe("capabilities are stated concretely enough to approve or refuse", () => {
  it("says what the agent can REACH, not what it helps with", () => {
    const text = describeCapabilities(["salesforce"]);
    expect(text).toContain("your Salesforce records");
    expect(text).toMatch(/checked and recorded before it happens/);
  });

  it("lists several systems readably", () => {
    const text = describeCapabilities(["jira", "github", "slack"]);
    expect(text).toContain("your Jira issues, your GitHub repositories and your Slack messages");
  });

  it("names an unknown connector rather than hiding it", () => {
    // A system we have no copy for is still a system the agent can reach.
    // Silence there would understate its access.
    expect(describeCapabilities(["acme-crm"])).toContain("your acme-crm account");
  });

  it("says plainly when an agent is connected to nothing", () => {
    // "It can reach nothing" is genuinely useful and reassuring.
    expect(describeCapabilities([])).toMatch(/not connected to any of your systems/);
  });

  it("does NOT report unknown bindings as none", () => {
    // The distinction that matters most here. Reporting "connected to nothing"
    // when we simply could not read the bindings is a confident false statement
    // on the surface someone uses to decide whether to trust the agent. The
    // detail endpoint does not return connectors today, so this is live.
    const text = describeCapabilities(undefined);
    expect(text).toMatch(/could not read/i);
    expect(text).toMatch(/not the same as it being connected to none/i);
  });
});

describe("state is described without jargon", () => {
  it.each([
    ["active", /can act right now/],
    ["paused", /not acting/],
    ["invited", /has done nothing at all/],
    ["revoked", /cannot act/],
  ])("describes %s in plain words", (state, pattern) => {
    expect(describeState(state).detail).toMatch(pattern);
  });

  it("does not report an unreadable state as idle", () => {
    // "We could not tell" and "it is doing nothing" are different facts.
    expect(describeState("something-new").detail).toMatch(/not the same as it being idle/);
  });
});

describe("the trust line never over-reads an absence of evidence", () => {
  it("does not call an unscored agent fine", () => {
    // The single most likely way a friendly card does damage.
    const t = trustLine({ state: "active", runs: 0 });
    expect(t.tone).toBe("unknown");
    expect(t.headline).toMatch(/nothing to judge it on/);
  });

  it("does not call a clean record good when the boundary was never proven", () => {
    // A clean record from a test that never ran is not evidence.
    const t = trustLine({ state: "active", runs: 12, standing: "good", boundaryProven: false });
    expect(t.tone).toBe("unknown");
    expect(t.headline).toMatch(/not yet proved its limits hold/);
  });

  it("reports good only when the boundary was demonstrated AND nothing went wrong", () => {
    const t = trustLine({ state: "active", runs: 12, standing: "good", boundaryProven: true });
    expect(t.tone).toBe("good");
    expect(t.headline).toMatch(/Stayed inside its limits across 12 tasks/);
  });

  it("leads with misbehavior over everything else", () => {
    // Including over a proven boundary: the boundary held and it still probed.
    const t = trustLine({ state: "active", runs: 40, standing: "attention", boundaryProven: true });
    expect(t.tone).toBe("attention");
    expect(t.headline).toMatch(/before this agent is given more access/);
  });

  it("says a revoked agent cannot act, whatever its history", () => {
    const t = trustLine({ state: "revoked", runs: 100, standing: "attention" });
    expect(t.headline).toMatch(/cannot act/);
  });

  it("gets the singular right, because '1 tasks' reads as a bug", () => {
    expect(trustLine({ state: "active", runs: 1, standing: "good", boundaryProven: true }).headline).toContain("1 task,");
  });
});

describe("whose model is behind it", () => {
  it("says a client model is governed the same way", () => {
    // The reassurance that makes bring-your-own-model adoptable: choosing your
    // own model does not opt you out of the checks.
    const text = describeModel("client:acme-llm", true);
    expect(text).toContain("your own model");
    expect(text).toMatch(/exactly the same checks as ours/);
  });

  it("says when the model is ours", () => {
    expect(describeModel("azure-gpt-4o", false)).toMatch(/supplied and governed by Wolfpack/);
  });

  it("does not invent a model that was never recorded", () => {
    expect(describeModel(undefined, false)).toMatch(/No model has been recorded/);
  });
});
