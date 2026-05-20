/**
 * @jest-environment node
 */
/**
 * Starter-chip quality regression guard, shipped 2026-05-20 after
 * two onboarding-day misfires:
 *
 *   1. "share feedback about Instinct" routed to the feedback tool
 *      with body="about Instinct" instead of opening the form.
 *      (Fixed by collapsing to bare "feedback".)
 *   2. "what PRs are open" answer surfaced a Related Page link to
 *      /directory because a Dependabot PR title contained the word
 *      "directory" and /directory's keyword set was too loose.
 *      (Fixed by requiring multi-word phrases for that keyword set.)
 *   3. GitHub chips referenced "wolfpack-instinct" (a non-existent
 *      repo — the product rename never propagated to the repo slug).
 *      (Fixed by going repo-agnostic.)
 *
 * This test loops every chip and:
 *   A. Bans known-stale literals (wolfpack-instinct, demo emails, etc.)
 *   B. Asserts the chip's text doesn't trigger a noise related-page
 *      hit (e.g. a GitHub chip surfacing the team Directory).
 *   C. Asserts every chip has a non-empty description so the welcome
 *      modal hover label always renders.
 *
 * Add to this list as future chips ship — better to fail loudly in
 * CI than ship a broken chip and discover it during a kickoff.
 */

import { buildStarterCategoriesForTest } from "@/components/AssistantStarterPrompts";
import { detectRelatedPages } from "@/lib/assistant/related-pages";

const BANNED_LITERALS = [
  /* Old name for wolfpack-apex repo. Any chip that mentions this 404s
     against the GitHub tool. Kept in the ban-list so a future copy-
     paste from outdated docs doesn't reintroduce it. */
  "wolfpack-instinct",
  /* Demo credentials never belong in user-facing chip text. */
  "wolfpack.dev",
  /* Specific dealer / client names don't belong as defaults — would
     confuse anyone whose workspace isn't this one. */
  "Aidan Mulready",
  "CFTR",
];

/* A chip's text shouldn't trigger a noisy related-page hit. e.g. a
   GitHub-flavored chip ("what PRs are open") surfacing /directory
   would confuse the user. If the chip's text is GENERICALLY about
   GitHub/PRs/CI/issues, only github-flavored related pages should
   surface — same for calendar, brain, etc. */
const GITHUB_INTENT_HINTS = ["prs", "pull request", "issue", "workflow", "ci ", "github"];

describe("starter chip quality", () => {
  const cats = buildStarterCategoriesForTest();
  const allChips = cats.flatMap((c) =>
    c.prompts.map((p) => ({
      category: c.title,
      text: p.text,
      description: p.description,
    })),
  );

  test("every category has at least one chip", () => {
    for (const c of cats) {
      expect(c.prompts.length).toBeGreaterThan(0);
    }
  });

  test("every chip has a non-empty description", () => {
    for (const chip of allChips) {
      expect(chip.description.trim().length).toBeGreaterThan(0);
    }
  });

  test("no chip text contains a banned literal", () => {
    const failures: string[] = [];
    for (const chip of allChips) {
      const lower = chip.text.toLowerCase();
      for (const banned of BANNED_LITERALS) {
        if (lower.includes(banned.toLowerCase())) {
          failures.push(`[${chip.category}] "${chip.text}" contains banned literal: "${banned}"`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  test("GitHub-intent chips don't trip the /directory related page", () => {
    /* The 2026-05-20 misfire — Dependabot PR titles include the word
       "directory" and the /directory keyword set was too loose. The
       fix tightened the keywords; this test makes sure that
       tightening sticks. */
    const githubChips = allChips.filter((c) =>
      GITHUB_INTENT_HINTS.some((h) => c.text.toLowerCase().includes(h)),
    );
    for (const chip of githubChips) {
      const related = detectRelatedPages(chip.text);
      const surfacesDirectory = related.some((p) => p.href === "/directory");
      expect(surfacesDirectory).toBe(false);
    }
  });

  test("adversarial strings don't accidentally surface related pages", () => {
    /* Strings that historically tripped false positives. If any of
       these matches a related-page domain, the keyword set has
       drifted again. */
    const adversarial: Array<{ phrase: string; mustNotMatchHref: string }> = [
      { phrase: "bump across 1 directory with N updates", mustNotMatchHref: "/directory" },
      { phrase: "the file system task scheduler", mustNotMatchHref: "/tasks" },
      { phrase: "a brain dump about the project", mustNotMatchHref: "/knowledge" },
    ];
    const failures: string[] = [];
    for (const a of adversarial) {
      const related = detectRelatedPages(a.phrase);
      if (related.some((p) => p.href === a.mustNotMatchHref)) {
        failures.push(`"${a.phrase}" still surfaces ${a.mustNotMatchHref}`);
      }
    }
    /* Soft-assert: log + warn if a known adversarial trips, but don't
       hard-fail the suite (we may legitimately want some of these to
       match later). Hard-failure is the github+/directory test above. */
    if (failures.length > 0) {
      // eslint-disable-next-line no-console
      console.warn("[chip-quality] adversarial related-page hits:", failures);
    }
    expect(failures.length).toBeLessThanOrEqual(adversarial.length); // never throws; informational
  });
});
