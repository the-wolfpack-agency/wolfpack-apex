/**
 * generate-release-notes.ts: the release-notes pipeline.
 *
 * Reads git commits since the last release, turns them into plain-English
 * feature breakdowns (what changed + how to use it), writes a release row via
 * the shared createRelease(), and emails the team via the shared Graph path.
 *
 * One AI step (grouping/rewording commits), wrapped in deterministic tooling:
 * if the AI gateway is unavailable it falls back to a commit-per-entry release,
 * so the pipeline NEVER fails to produce a release.
 *
 * Usage:
 *   npm run release:notes -- [--since=<git-ref>] [--version=<label>]
 *                            [--title=<title>] [--repo=<path>]
 *                            [--dry-run] [--no-email]
 *
 *   --since     git ref to diff from (default: last tag, else last 40 commits)
 *   --repo      read commits from ANOTHER repo. /releases is the org-wide
 *               changelog, and most weeks the work ships in a sibling repo
 *               (porsche-weekend, beyond, auto), so the generator cannot be
 *               limited to the repo it happens to live in.
 *   --entries   path to a JSON array of curated entries, used INSTEAD of the
 *               AI grouping. Same shape as ReleaseEntry:
 *               [{ title, description, how_to_use, category, area }]
 *   --version   release version/label (default: today, YYYY-MM-DD)
 *   --title     release title (default: "Release <version>")
 *   --dry-run   print the release JSON; do not write or email
 *   --no-email  write the release but skip the team email
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { getAIClient, NoProviderAvailableError } from "@/lib/ai";
import { createRelease, formatDiffStat, type DiffStat, type ReleaseEntry } from "@/lib/releases";
import { isGraphMailConfigured, sendViaGraph } from "@/lib/mail/send-via-graph";
import { safeQuery } from "@/lib/db";

interface Args {
  since?: string;
  version: string;
  title?: string;
  repo?: string;
  entriesFile?: string;
  dryRun: boolean;
  email: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (k: string) =>
    argv.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=");
  const today = new Date().toISOString().slice(0, 10);
  const version = get("version") || today;
  return {
    since: get("since"),
    version,
    title: get("title"),
    repo: get("repo"),
    entriesFile: get("entries"),
    dryRun: argv.includes("--dry-run"),
    email: !argv.includes("--no-email"),
  };
}

/**
 * Run git with an ARGUMENT LIST, never a command string.
 *
 * The previous shape was execSync(`git ${cmd}`), which hands the whole thing to
 * a shell. `--since` comes from argv, so `--since='x; rm -rf ~'` was a shell
 * command rather than a revision. It needed someone able to pass a flag to this
 * script to be a problem, which is a narrow door, but it is a door with nothing
 * behind it: git takes a list perfectly well, and execFileSync with no shell
 * means the argument cannot be anything except an argument.
 */
function git(args: string[], repo?: string): string {
  return execFileSync("git", args, { encoding: "utf8", cwd: repo || process.cwd() }).trim();
}

/**
 * The revision range, as an argument list.
 *
 * Shared by the log and the diffstat so the two can never describe different
 * spans of work: a summary that counts one range's commits and another range's
 * lines is worse than no numbers at all.
 */
function revRange(since: string | undefined, repo: string | undefined): string[] {
  if (since) return [`${since}..HEAD`];
  try {
    const lastTag = git(["describe", "--tags", "--abbrev=0"], repo);
    if (lastTag) return [`${lastTag}..HEAD`];
  } catch {
    /* no tags in this repo */
  }
  return [];
}

/** Commit subjects since `since` (or the last tag, or the last 40 commits). */
function commitsSince(since?: string, repo?: string): string[] {
  try {
    const range = revRange(since, repo);
    // The range is one argument, or absent. Splitting it into the arg list is
    // what keeps a revision a revision.
    const raw = git(["log", ...(range.length ? range : ["-n", "40"]), "--pretty=%s"], repo);
    return raw
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      // Drop pure-noise commits so the notes stay user-facing.
      .filter((s) => !/^(chore\(deps\)|Merge branch|Merge remote|bump )/i.test(s));
  } catch {
    return [];
  }
}

/**
 * How much actually changed, over the same range as the commit list.
 *
 * `--shortstat` rather than parsing a full diff: it is one line, it is stable
 * across git versions, and it costs nothing on a large range. Lock files and
 * generated bundles are excluded because a dependency bump that rewrites
 * package-lock.json reports tens of thousands of lines and drowns the real
 * number, which is the one a person is actually asking for.
 */
function diffStat(since: string | undefined, repo: string | undefined, commits: number): DiffStat {
  const empty: DiffStat = { commits, files: 0, insertions: 0, deletions: 0 };
  try {
    const range = revRange(since, repo);
    if (!range.length) return empty;
    const raw = git(
      [
        "diff",
        "--shortstat",
        ...range,
        "--",
        ".",
        ":(exclude)*package-lock.json",
        ":(exclude)*pnpm-lock.yaml",
        ":(exclude)*yarn.lock",
        ":(exclude)*.min.js",
        ":(exclude)*.map",
      ],
      repo,
    );
    const n = (re: RegExp) => Number(re.exec(raw)?.[1] ?? 0);
    return {
      commits,
      files: n(/(\d+) files? changed/),
      insertions: n(/(\d+) insertions?\(\+\)/),
      deletions: n(/(\d+) deletions?\(-\)/),
    };
  } catch {
    return empty;
  }
}

/**
 * Curated entries from a file, validated rather than trusted.
 *
 * Exits on a bad file instead of publishing a partial release: this writes to
 * the changelog the whole team reads, and a silently-empty release is harder to
 * notice than a script that refused to run.
 */
function readEntriesFile(path: string): { summary: string; entries: ReleaseEntry[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    console.error(`[release-notes] could not read --entries=${path}: ${(err as Error).message}`);
    process.exit(1);
  }
  // Either a bare array, or {summary, entries} when the release wants a lede.
  const obj = (Array.isArray(parsed) ? { entries: parsed } : parsed) as {
    summary?: unknown;
    entries?: unknown;
  };
  if (!Array.isArray(obj?.entries) || obj.entries.length === 0) {
    console.error(`[release-notes] --entries=${path} must be a non-empty array, or {summary, entries}.`);
    process.exit(1);
  }
  const entries = obj.entries as ReleaseEntry[];
  const bad = entries.findIndex((e) => !e || typeof e.title !== "string" || !e.title.trim());
  if (bad > -1) {
    console.error(`[release-notes] --entries=${path}: entry ${bad} has no title.`);
    process.exit(1);
  }
  return { summary: typeof obj.summary === "string" ? obj.summary : "", entries };
}

/** Strip ```json fences the model sometimes adds. */
function stripFences(s: string): string {
  return s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

/** Deterministic fallback: one entry per commit, no AI. */
function fallbackEntries(commits: string[]): { summary: string; entries: ReleaseEntry[] } {
  return {
    summary: `${commits.length} change${commits.length === 1 ? "" : "s"} in this release.`,
    entries: commits.map((c) => ({
      title: c.replace(/^\w+(\([^)]*\))?:\s*/, ""), // drop conventional-commit prefix
      description: "",
      how_to_use: "",
      category: /^fix/i.test(c) ? "fix" : /^(feat|add)/i.test(c) ? "feature" : "improvement",
    })),
  };
}

const SYSTEM_PROMPT = `You write release notes for a non-technical internal team (the Wolfpack).
Given a list of git commit messages, group them into user-facing entries.
For each entry write:
 - "title": a short plain-English headline (no code/jargon)
 - "description": 1-2 plain sentences on what changed and why it helps
 - "how_to_use": 1 plain sentence on how a team member uses it, or "" if not applicable
 - "category": one of "feature", "fix", "improvement"
 - "area": the product area if obvious (e.g. "Auto", "Instinct", "LMS"), else omit
Also write a one-paragraph "summary" of the release.
Merge trivial/duplicate commits. Skip pure chores.
Respond with ONLY valid JSON: {"summary": string, "entries": [{"title","description","how_to_use","category","area"}]}`;

async function generate(commits: string[]): Promise<{ summary: string; entries: ReleaseEntry[] }> {
  if (commits.length === 0) return { summary: "No changes.", entries: [] };
  try {
    const client = getAIClient();
    const res = await client.complete({
      messages: [{ role: "user", content: commits.map((c) => `- ${c}`).join("\n") }],
      system: SYSTEM_PROMPT,
      max_tokens: 2000,
      temperature: 0.2,
      model_tier: "standard",
      apply_constitution: false,
      metadata: { feature: "release_notes", user_id: "system", user_role: "system" },
    });
    const parsed = JSON.parse(stripFences(res.content)) as {
      summary?: string;
      entries?: ReleaseEntry[];
    };
    const entries = Array.isArray(parsed.entries)
      ? parsed.entries.filter((e) => e && typeof e.title === "string" && e.title.trim())
      : [];
    if (entries.length === 0) return fallbackEntries(commits);
    return { summary: parsed.summary?.trim() || fallbackEntries(commits).summary, entries };
  } catch (err) {
    const why = err instanceof NoProviderAvailableError ? "no AI provider" : (err as Error).message;
    console.warn(`[release-notes] AI unavailable (${why}); using deterministic fallback.`);
    return fallbackEntries(commits);
  }
}

function renderEmailHtml(version: string, title: string, summary: string, entries: ReleaseEntry[]): string {
  const rows = entries
    .map(
      (e) => `
      <li style="margin:0 0 14px;">
        <strong style="color:#111;">${escapeHtml(e.title)}</strong>
        ${e.description ? `<div style="color:#444;margin:2px 0;">${escapeHtml(e.description)}</div>` : ""}
        ${e.how_to_use ? `<div style="color:#0b0d11;background:#faf6e6;border-left:3px solid #e8b528;padding:6px 10px;margin-top:4px;"><em>How to use:</em> ${escapeHtml(e.how_to_use)}</div>` : ""}
      </li>`,
    )
    .join("");
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:600px;margin:0 auto;">
    <h1 style="font-size:20px;color:#111;">${escapeHtml(title)}</h1>
    <p style="color:#555;">${escapeHtml(summary)}</p>
    <ul style="list-style:none;padding:0;">${rows}</ul>
    <p style="color:#888;font-size:13px;">See all releases at Instinct → Releases.</p>
  </div>`;
}

function escapeHtml(s: string): string {
  const map: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
  return s.replace(/[&<>"]/g, (c) => map[c] ?? c);
}

async function emailTeam(version: string, title: string, summary: string, entries: ReleaseEntry[]): Promise<void> {
  if (!isGraphMailConfigured()) {
    console.log("[release-notes] Graph mail not configured; skipping team email.");
    return;
  }
  const { rows } = await safeQuery<{ name: string; email: string }>(
    "SELECT name, email FROM instinct_team_members WHERE is_active = true AND email IS NOT NULL",
  );
  if (rows.length === 0) {
    console.log("[release-notes] no active team recipients; skipping email.");
    return;
  }
  const html = renderEmailHtml(version, title, summary, entries);
  const text = `${title}\n\n${summary}\n\n${entries.map((e) => `- ${e.title}${e.how_to_use ? ` (How to use: ${e.how_to_use})` : ""}`).join("\n")}`;
  let delivered = 0;
  for (const r of rows) {
    const out = await sendViaGraph({ to: r.email, subject: `What's new: ${title}`, text, html });
    if (out.delivered) delivered++;
  }
  console.log(`[release-notes] emailed ${delivered}/${rows.length} teammates.`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.repo) {
    // Fail loudly rather than silently describing THIS repo's commits as the
    // other one's, which is a wrong changelog that looks entirely plausible.
    try {
      git(["rev-parse", "--git-dir"], args.repo);
    } catch {
      console.error(`[release-notes] --repo=${args.repo} is not a git repository.`);
      process.exit(1);
    }
  }
  const commits = commitsSince(args.since, args.repo);
  const stats = diffStat(args.since, args.repo, commits.length);
  console.log(
    `[release-notes] ${commits.length} commit(s) since ${args.since ?? "last tag"}` +
      `${args.repo ? ` in ${args.repo}` : ""}. ${formatDiffStat(stats)}`,
  );

  /* Curated entries win over the AI grouping.
   *
   * The AI step needs a provider key, and the deterministic fallback is one
   * entry per commit with no description: for a 112-commit release that is a
   * wall of commit subjects on a page written for a non-technical team, which
   * is worse than the wall of nothing it replaced. --entries lets the release
   * be written properly and still go out through this same path, so it gets
   * the same stats, the same createRelease() and the same email. */
  const generated = args.entriesFile ? readEntriesFile(args.entriesFile) : await generate(commits);
  const entries = generated.entries;
  /* The size of the release goes in the summary rather than a new column: it
     is the line people ask for ("what shipped, how much"), the timeline already
     renders the summary, and a schema change to carry four integers that are
     only ever read as one sentence would be the wrong trade. */
  const summary = `${generated.summary} ${formatDiffStat(stats)}`.trim();
  const title = args.title || `Release ${args.version}`;

  const payload = { version: args.version, title, summary, entries };

  if (args.dryRun) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (!process.env.DATABASE_URL) {
    console.error("[release-notes] DATABASE_URL not set; cannot write the release. Use --dry-run to preview.");
    process.exit(1);
  }

  const release = await createRelease({ ...payload, created_by: "release-notes-generator" });
  console.log(`[release-notes] published release "${release.title}" (${release.entries.length} entries).`);

  if (args.email) {
    await emailTeam(release.version, release.title, release.summary, release.entries);
  }
}

main().catch((err) => {
  console.error("[release-notes] failed:", err);
  process.exit(1);
});
