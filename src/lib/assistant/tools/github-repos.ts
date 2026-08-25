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
    const { rows } = await safeQuery<{ github_repo: string }>(
      `SELECT DISTINCT github_repo
         FROM instinct_site_projects
        WHERE github_repo IS NOT NULL AND btrim(github_repo) <> ''
        ORDER BY github_repo
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
