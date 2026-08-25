import type { ClarifyWidgetSpec } from "@/lib/assistant/widgets/types";

/**
 * Which repositories are ours, and what to say when nobody named one.
 *
 * WHY THIS IS SHARED. Three tools answer questions about GitHub - workflow
 * runs, issues, pull requests - and none of them can act without a repository.
 * People do not name one: "is CI green", "any open issues", "what is waiting
 * for review" are all real questions and none of them says where.
 *
 * There is no default-repo setting in this codebase, and inventing one would
 * mean answering confidently about a repository nobody mentioned. So the
 * answer is to ask, and to ask WELL: naming the repos we already manage turns
 * a dead end into one more word from the person.
 *
 * Written once because the alternative is three copies of the same question
 * that drift apart, and the day they disagree is the day somebody notices the
 * assistant has two personalities.
 */

/**
 * The repositories this workspace already manages.
 *
 * Read from the sites table, because that is where a repo BECOMES ours: it is
 * written when a site is created from the template. A second list of "our
 * repos" would disagree with it the first time somebody deleted a site.
 *
 * instinct_site_projects carries no workspace_id - see migration 009 and the
 * 067 rename - so this is deliberately not workspace-scoped.
 */
export async function knownRepos(): Promise<string[]> {
  if (!process.env.DATABASE_URL) return [];
  try {
    const { safeQuery } = await import("@/lib/db");
    /* READY, AND RECENT FIRST.
     *
     * This ordered alphabetically over every row, which put seven scratch
     * repos at the top of the list: wolfpack-test10, test11, test12, test2,
     * test3, test4, test6. Found by reading the actual answer through
     * scripts/prompt-transcript.ts, which is the only way a menu of junk shows
     * up - the query was correct, the tool worked, and the reply was useless.
     *
     * A site that failed to deploy is not one to ask about the build of, so
     * status carries the filter, and the most recently touched come first
     * because those are the ones somebody is working in. */
    const { rows } = await safeQuery<{ github_repo: string }>(
      `SELECT github_repo
         FROM instinct_site_projects
        WHERE github_repo IS NOT NULL AND btrim(github_repo) <> ''
          AND status = 'ready'
        GROUP BY github_repo
        ORDER BY max(updated_at) DESC
        LIMIT 8`,
      [],
    );
    return rows.map((r) => String(r.github_repo));
  } catch {
    /* The question is still worth asking without the list. */
    return [];
  }
}

/**
 * The question, with the answer made as cheap as possible to give.
 *
 * `example` is a whole sentence the person can retype, not a parameter name.
 * Being told "specify a repository" is being given homework; being shown
 * "any open issues in wolfpack-apex" is being given the answer.
 */
export function askWhichRepo(known: string[], example: (repo: string) => string): string {
  if (known.length === 0) {
    return `Which repository? Name it and I will look, for example **${example("wolfpack-apex")}**.`;
  }
  return [
    "Which repository? I can look in any of these:",
    "",
    ...known.map((r) => `- \`${r}\``),
    "",
    `Say for example **${example(known[0])}**.`,
  ].join("\n");
}

/**
 * The same question, as buttons.
 *
 * A prose list of repositories is a list of things to retype, and retyping is
 * where people give up: the whole reason the tool asked is that it could not
 * work the answer out, and making them spell it back is a poor trade. One tap
 * re-sends the question with the repository in it.
 *
 * Reuses the clarify widget rather than adding a kind. It is already chips
 * that re-send a prompt, already styled, already carries its analytics both
 * ways, and the only thing that did not fit was a sentence about typos.
 */
export function whichRepoWidget(
  question: string,
  known: string[],
  example: (repo: string) => string,
): ClarifyWidgetSpec | null {
  /* Nothing to offer is not a picker. The prose answer still names the shape
     of the thing to type, which is better than an empty box. */
  if (known.length === 0) return null;
  return {
    kind: "clarify",
    title: "Which repository?",
    originalQuery: question,
    subtitle: "Pick one and I will run it.",
    suggestions: known.slice(0, 6).map((repo) => ({
      label: repo,
      query: example(repo),
    })),
  };
}
