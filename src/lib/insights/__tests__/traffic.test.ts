/**
 * Telling a person's question from our own machinery asking one.
 *
 * The most striking insight produced today was that one document had answered
 * 754 questions. It was our own test traffic: 282 citations on 30 August and
 * 358 on 29 August, the two days an eval harness ran against production.
 */
import {
  isServiceIdentity,
  splitTraffic,
  describeTraffic,
  KNOWN_SERVICE_IDENTITIES,
  NOTABLE_SERVICE_SHARE,
} from "../traffic";

describe("who asked", () => {
  it("treats an account id as a person", () => {
    expect(isServiceIdentity("165139f0-6c15-4f9d-bc67-063cb2201234")).toBe(false);
  });

  it("treats an email address as a person", () => {
    expect(isServiceIdentity("nick@thewolfpack.agency")).toBe(false);
  });

  /* The identities that produced half the log. */
  it("catches the tooling built this week", () => {
    for (const id of ["eval", "transcript-probe", "agent-1", "demo-cto", "walkthrough"]) {
      expect(isServiceIdentity(id)).toBe(true);
    }
  });

  /* An absent identity cannot be shown to be a person, and counting it as one
     would put unattributable traffic into a client's numbers. */
  it("treats a missing identity as machinery", () => {
    expect(isServiceIdentity(null)).toBe(true);
    expect(isServiceIdentity("")).toBe(true);
  });

  /* SHAPE, NOT A DENYLIST. A list is right today and wrong the moment
     somebody adds a script, and says nothing about a client's deployment. */
  it("catches a service name nobody has added to the list", () => {
    expect(KNOWN_SERVICE_IDENTITIES).not.toContain("some-new-harness");
    expect(isServiceIdentity("some-new-harness")).toBe(true);
  });
});

describe("splitting a log", () => {
  const rows = [
    { user_id: "165139f0-6c15-4f9d-bc67-063cb2201234", q: "real" },
    { user_id: "nick@thewolfpack.agency", q: "real" },
    { user_id: "eval", q: "harness" },
    { user_id: "transcript-probe", q: "harness" },
  ];

  it("keeps the people and sets the machinery aside", () => {
    const split = splitTraffic(rows, (r) => r.user_id);
    expect(split.human).toHaveLength(2);
    expect(split.service).toHaveLength(2);
    expect(split.serviceShare).toBe(0.5);
  });

  it("reports nothing to split when there is nothing", () => {
    expect(splitTraffic([], () => null).serviceShare).toBe(0);
  });
});

describe("saying so rather than quietly discarding", () => {
  /* If a client's people have usernames rather than account ids this rule
     would drop all of them, and the insight would read as an empty estate.
     The share is what makes that visible. */
  it("says how much was excluded when the share is high", () => {
    const split = splitTraffic(
      [{ id: "eval" }, { id: "eval" }, { id: "nick@x.com" }],
      (r) => r.id,
    );
    const text = describeTraffic(split)!;
    expect(text).toMatch(/67 per cent/);
    expect(text).toMatch(/worth checking how people sign in/i);
  });

  it("stays quiet when almost all of it is people", () => {
    const split = splitTraffic(
      [{ id: "a@x.com" }, { id: "b@x.com" }, { id: "c@x.com" }, { id: "d@x.com" }, { id: "eval" }],
      (r) => r.id,
    );
    expect(split.serviceShare).toBeLessThan(NOTABLE_SERVICE_SHARE + 0.01);
  });
});
