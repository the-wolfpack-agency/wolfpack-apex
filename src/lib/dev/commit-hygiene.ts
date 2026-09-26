/**
 * Commit hygiene: decidable rules over a commit's own metadata.
 *
 * These are house rules that lived only in memory and so were only as reliable
 * as remembering them: commits must be authored as the GitHub noreply identity,
 * must not carry a Co-Authored-By trailer, and must never carry a private email.
 * Each is a pure predicate over (authorEmail, message), so it is trivially
 * testable and cannot drift. The git plumbing that gathers the commits lives in
 * scripts/check-commit-hygiene.ts; this only judges.
 */

export interface CommitRecord {
  /** Short sha, for a legible violation. Optional. */
  sha?: string;
  authorEmail: string;
  message: string;
}

export interface CommitHygieneOptions {
  /** The only author identity commits may carry. */
  expectedAuthorEmail: string;
  /** Emails that must never appear in an author field or a message. */
  forbiddenEmails: readonly string[];
}

export interface HygieneViolation {
  sha?: string;
  rule: string;
  detail: string;
}

const COAUTHORED_BY = /co-authored-by\s*:/i;

/** Judge one commit. Returns every rule it breaks (a commit can break more than one). */
export function checkCommit(commit: CommitRecord, opts: CommitHygieneOptions): HygieneViolation[] {
  const out: HygieneViolation[] = [];
  const at = (rule: string, detail: string) => out.push({ sha: commit.sha, rule, detail });

  if (commit.authorEmail !== opts.expectedAuthorEmail) {
    at("H-COMMIT-AUTHOR-EMAIL", `author is "${commit.authorEmail}", expected "${opts.expectedAuthorEmail}"`);
  }
  if (COAUTHORED_BY.test(commit.message)) {
    at("H-NO-COAUTHORED-BY", "commit message carries a Co-Authored-By trailer");
  }
  for (const email of opts.forbiddenEmails) {
    if (commit.authorEmail.includes(email) || commit.message.includes(email)) {
      at("H-NO-PRIVATE-EMAIL", `a forbidden email (${email}) appears in the commit author or message`);
    }
  }
  return out;
}

/** Judge every commit on the branch. Empty array = clean. */
export function checkCommits(commits: readonly CommitRecord[], opts: CommitHygieneOptions): HygieneViolation[] {
  return commits.flatMap((c) => checkCommit(c, opts));
}

/** The house identity + forbidden set, in one place. */
export const DEFAULT_HYGIENE: CommitHygieneOptions = {
  expectedAuthorEmail: "25436368+nhomyk@users.noreply.github.com",
  forbiddenEmails: ["nickhomyk@gmail.com"],
};
