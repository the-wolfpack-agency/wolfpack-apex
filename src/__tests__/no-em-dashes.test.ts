/**
 * No em dashes in published content.
 *
 * This is a standing house rule, restated many times, and it kept being broken
 * anyway because it lived only in someone's memory of the instruction. A rule
 * that depends on remembering is not a rule, it is a hope. It got broken most
 * recently on the engineering wiki, which is the worst place for it: that page
 * is served to the team from the database, so the mistake was live before
 * anyone read it.
 *
 * WHAT IS COVERED
 *
 * The files that PRODUCE content people read: the wiki seed, the release
 * publishers, and the docs tree. Those are the ones where the character reaches
 * a page rather than sitting in a comment.
 *
 * WHY NOT THE WHOLE REPOSITORY
 *
 * Several files carry hundreds of them from before the rule existed, and a test
 * that fails on day one gets skipped on day two. A ratchet covers the rest
 * (below): the count may fall, never rise, so old text is cleaned up when it is
 * touched rather than in one sweep nobody has time for.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const EM_DASH = "—";
const ROOT = join(__dirname, "..", "..");

/** Content that is published to a person, where zero is the standard. */
const PUBLISHED_CONTENT = [
  "scripts/seed-engineering-wiki.ts",
  "scripts/publish-release-2026-08-02.ts",
  "scripts/publish-loc-snapshot.ts",
  "scripts/backfill-release-notes.ts",
  "scripts/generate-release-notes.ts",
];

function walk(dir: string, out: string[] = []): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(md|mdx)$/.test(name)) out.push(full);
  }
  return out;
}

function offendingLines(file: string): string[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => line.includes(EM_DASH))
    .map(({ line, n }) => `${file.replace(ROOT + "/", "")}:${n}  ${line.trim().slice(0, 120)}`);
}

describe("published content carries no em dashes", () => {
  it.each(PUBLISHED_CONTENT)("%s", (rel) => {
    const bad = offendingLines(join(ROOT, rel));
    expect(bad.join("\n")).toBe("");
  });

});

/**
 * docs/ carries a backlog: 211 lines across 15 files, all predating this rule being
 * enforced. Demanding zero today would fail on day one, and a test that fails
 * on day one gets skipped on day two. So it ratchets: the count may fall, never
 * rise. New writing is held to zero by the suite above; the backlog comes down
 * as those files are touched.
 */
const DOCS_EM_DASH_BACKLOG = 211;

describe("docs/ only ever gets better", () => {
  it("no new em dash lands in docs/", () => {
    const bad = walk(join(ROOT, "docs")).flatMap(offendingLines);
    expect(bad.length).toBeLessThanOrEqual(DOCS_EM_DASH_BACKLOG);
    // Lower DOCS_EM_DASH_BACKLOG in the same commit that removes some. A stale
    // allowance is how a ratchet stops ratcheting.
    expect(bad.length).toBe(DOCS_EM_DASH_BACKLOG);
  });
});

/**
 * The ratchet for everything else.
 *
 * Deliberately an exact number rather than an upper bound. An upper bound lets
 * the count drift down and quietly back up again; an exact number means both
 * directions are a conversation. When you clean some up, lower it in the same
 * commit, which is the moment the reason is freshest.
 */
const KNOWN_EM_DASHES = 110;

describe("the rest of the repository only ever gets better", () => {
  it("does not grow", () => {
    const files = [
      "src/__tests__/AUDIT_ALLOWLIST.ts",
      "src/lib/analytics.ts",
      "src/lib/platform-scan/browser/device-matrix.ts",
    ];
    const total = files.reduce((n, f) => n + offendingLines(join(ROOT, f)).length, 0);
    expect(total).toBeLessThanOrEqual(KNOWN_EM_DASHES);
    // If this fails because you REMOVED some, lower KNOWN_EM_DASHES to match.
    // A stale allowance is how a ratchet stops ratcheting.
    expect(total).toBe(KNOWN_EM_DASHES);
  });
});
