/**
 * Prove-it-fails for commit hygiene: each rule fires on the exact bad commit and
 * a clean commit passes. Pure over commit metadata, so no repository is needed.
 */
import { checkCommit, checkCommits, DEFAULT_HYGIENE } from "../commit-hygiene";

const clean = { sha: "abc123", authorEmail: DEFAULT_HYGIENE.expectedAuthorEmail, message: "feat: a real change\n\nbody" };

describe("checkCommit", () => {
  it("passes a clean commit", () => {
    expect(checkCommit(clean, DEFAULT_HYGIENE)).toEqual([]);
  });

  it("flags the wrong author identity", () => {
    const v = checkCommit({ ...clean, authorEmail: "someone@example.com" }, DEFAULT_HYGIENE);
    expect(v.map((x) => x.rule)).toContain("H-COMMIT-AUTHOR-EMAIL");
  });

  it("flags a Co-Authored-By trailer (any casing)", () => {
    const v = checkCommit({ ...clean, message: "fix: thing\n\nCo-authored-by: Someone <x@y.z>" }, DEFAULT_HYGIENE);
    expect(v.map((x) => x.rule)).toContain("H-NO-COAUTHORED-BY");
  });

  it("flags a forbidden private email in the message", () => {
    const v = checkCommit({ ...clean, message: "chore: ping nickhomyk@gmail.com" }, DEFAULT_HYGIENE);
    expect(v.map((x) => x.rule)).toContain("H-NO-PRIVATE-EMAIL");
  });

  it("flags a forbidden private email in the author field", () => {
    const v = checkCommit({ ...clean, authorEmail: "nickhomyk@gmail.com" }, DEFAULT_HYGIENE);
    const rules = v.map((x) => x.rule);
    // both the wrong-identity and forbidden-email rules fire, which is correct
    expect(rules).toContain("H-NO-PRIVATE-EMAIL");
    expect(rules).toContain("H-COMMIT-AUTHOR-EMAIL");
  });

  it("reports every rule a single commit breaks", () => {
    const v = checkCommit({ authorEmail: "nickhomyk@gmail.com", message: "x\n\nCo-Authored-By: A <a@b.c>" }, DEFAULT_HYGIENE);
    expect(new Set(v.map((x) => x.rule))).toEqual(new Set(["H-COMMIT-AUTHOR-EMAIL", "H-NO-COAUTHORED-BY", "H-NO-PRIVATE-EMAIL"]));
  });
});

describe("checkCommits", () => {
  it("is empty for an all-clean branch", () => {
    expect(checkCommits([clean, { ...clean, sha: "def" }], DEFAULT_HYGIENE)).toEqual([]);
  });
  it("collects violations across commits", () => {
    const v = checkCommits([clean, { sha: "bad", authorEmail: "x@y.z", message: "m" }], DEFAULT_HYGIENE);
    expect(v).toHaveLength(1);
    expect(v[0].sha).toBe("bad");
  });
});
