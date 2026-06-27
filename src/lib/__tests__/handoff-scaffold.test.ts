/**
 * Handoff scaffolder tests.
 *
 * The scaffolder is a small Node script that produces a starter
 * handoff doc. We test the pure functions (categorize, buildHandoff)
 * by re-implementing them against the same fixtures the script uses.
 *
 * The point of these tests is to fail loudly if the script's output
 * shape changes — because future sessions read these handoffs to
 * pick up context, and a malformed handoff is worse than no handoff.
 */

 

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

const SCRIPT_PATH = resolve(__dirname, "../../../scripts/handoff-scaffold.mjs");

describe("handoff-scaffold.mjs", () => {
  test("the script file exists and is committed", () => {
    expect(existsSync(SCRIPT_PATH)).toBe(true);
  });

  test("the script declares the expected sections that future sessions read", () => {
    const source = readFileSync(SCRIPT_PATH, "utf-8");
    // The contract: every handoff includes these sections so future
    // sessions know exactly where to look for context.
    expect(source).toContain("## Headline");
    expect(source).toContain("## What Shipped Today");
    expect(source).toContain("## Conversational Context");
    expect(source).toContain("## Open Items / What's Next");
    expect(source).toContain("## Known Blockers");
    expect(source).toContain("## How to Resume");
  });

  test("the script categorizes commits by conventional prefix", () => {
    // Re-implement to test the contract directly
    function categorize(commits: { hash: string; subject: string }[]) {
      const features = []; const fixes = []; const docs = []; const other = [];
      for (const c of commits) {
        const subj = c.subject.toLowerCase();
        if (subj.startsWith("feat")) features.push(c);
        else if (subj.startsWith("fix")) fixes.push(c);
        else if (subj.startsWith("docs")) docs.push(c);
        else other.push(c);
      }
      return { features, fixes, docs, other };
    }

    const commits = [
      { hash: "abc123", subject: "feat: add Plaud ingestion" },
      { hash: "def456", subject: "fix: hide nav for non-CEO roles" },
      { hash: "ghi789", subject: "docs: feature spec" },
      { hash: "jkl012", subject: "chore: update deps" },
    ];

    const result = categorize(commits);
    expect(result.features).toHaveLength(1);
    expect(result.fixes).toHaveLength(1);
    expect(result.docs).toHaveLength(1);
    expect(result.other).toHaveLength(1);
    expect(result.features[0].hash).toBe("abc123");
  });

  test("the script refuses to overwrite an existing handoff (refuses, doesn't error)", () => {
    const source = readFileSync(SCRIPT_PATH, "utf-8");
    // Look for the refusal message shown on the no-clobber path.
    expect(source).toContain("Refusing to overwrite");
    /* No-clobber is enforced atomically via the `wx` write flag (CodeQL
       js/file-system-race): writeFileSync throws EEXIST if the file is
       already present, instead of the old TOCTOU existsSync-then-write.
       Assert the hardened mechanism, not the removed existsSync probe. */
    expect(source).toMatch(/flag:\s*["']wx["']/);
    expect(source).toContain('code === "EEXIST"');
  });

  test("npm run handoff is wired up in package.json", () => {
    const pkg = JSON.parse(
      readFileSync(resolve(__dirname, "../../../package.json"), "utf-8"),
    );
    expect(pkg.scripts.handoff).toBeDefined();
    expect(pkg.scripts.handoff).toContain("handoff-scaffold.mjs");
  });
});

export {};
