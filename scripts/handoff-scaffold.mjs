#!/usr/bin/env node
/**
 * Scaffold a session handoff doc.
 *
 * Reads:
 *   - Today's date
 *   - The most recent existing handoff in demo/handoff-*.md
 *   - Recent commits since that handoff (or last 24h if none found)
 *
 * Writes:
 *   - demo/handoff-YYYY-MM-DD.md  (skipped if it already exists)
 *
 * The output is a *starter* — it captures what shipped (commits) and
 * leaves placeholder sections for the human/AI to fill in. The point
 * is to make the writing step frictionless so it actually happens at
 * the end of every session.
 *
 * Usage:  node scripts/handoff-scaffold.mjs
 *         npm run handoff   (if package.json script is wired up)
 */
import { readdirSync, existsSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const DEMO_DIR = resolve(REPO_ROOT, "demo");

function todayIso() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function findLatestHandoff() {
  if (!existsSync(DEMO_DIR)) return null;
  const files = readdirSync(DEMO_DIR)
    .filter((f) => /^handoff-\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .sort()
    .reverse();
  if (files.length === 0) return null;
  // Extract YYYY-MM-DD
  const m = files[0].match(/handoff-(\d{4}-\d{2}-\d{2})\.md/);
  return m ? { name: files[0], date: m[1] } : null;
}

function gitLogSince(sinceDate) {
  // Use execFileSync with an argv array so `sinceDate` (parsed from a
  // filename earlier in this module) can never be interpreted as shell
  // metacharacters. CodeQL flagged the original
  // js/shell-command-injection-from-environment + indirect injection.
  // `sinceDate` is also re-validated to YYYY-MM-DD before use.
  try {
    const args = [
      "-C",
      REPO_ROOT,
      "log",
      sinceDate && /^\d{4}-\d{2}-\d{2}$/.test(sinceDate)
        ? `--since=${sinceDate}`
        : `--since=24 hours ago`,
      "--pretty=format:%h|%s",
      "--no-merges",
    ];
    const out = execFileSync("git", args, { encoding: "utf-8" });
    return out
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        const [hash, ...rest] = line.split("|");
        return { hash, subject: rest.join("|") };
      });
  } catch {
    return [];
  }
}

function gitHead() {
  try {
    return execFileSync("git", ["-C", REPO_ROOT, "rev-parse", "--short", "HEAD"], {
      encoding: "utf-8",
    }).trim();
  } catch {
    return "(unknown)";
  }
}

function categorize(commits) {
  const features = [];
  const fixes = [];
  const docs = [];
  const other = [];
  for (const c of commits) {
    const subj = c.subject.toLowerCase();
    if (subj.startsWith("feat")) features.push(c);
    else if (subj.startsWith("fix")) fixes.push(c);
    else if (subj.startsWith("docs")) docs.push(c);
    else other.push(c);
  }
  return { features, fixes, docs, other };
}

function bullet(c) {
  return `- \`${c.hash}\` ${c.subject}`;
}

function buildHandoff(date, latest, commits) {
  const head = gitHead();
  const cat = categorize(commits);
  const sections = [];

  sections.push(`# Wolfpack Instinct — Session Handoff`);
  sections.push(`**Date:** ${date}`);
  sections.push(`**HEAD commit:** \`${head}\``);
  sections.push(`**Deployed:** https://wolfpack-instinct.vercel.app`);
  sections.push(`**Repo:** the-wolfpack-agency/wolfpack-apex`);
  sections.push("");
  sections.push("---");
  sections.push("");
  sections.push("## Headline");
  sections.push("");
  sections.push("_(One sentence summarizing the day's biggest change. Fill in.)_");
  sections.push("");
  sections.push("---");
  sections.push("");
  sections.push("## What Shipped Today");
  if (latest) {
    sections.push(`_(Commits since the last handoff on ${latest.date}.)_`);
  } else {
    sections.push("_(Commits in the last 24 hours.)_");
  }
  sections.push("");

  if (cat.features.length > 0) {
    sections.push("### Features");
    for (const c of cat.features) sections.push(bullet(c));
    sections.push("");
  }
  if (cat.fixes.length > 0) {
    sections.push("### Fixes");
    for (const c of cat.fixes) sections.push(bullet(c));
    sections.push("");
  }
  if (cat.docs.length > 0) {
    sections.push("### Docs");
    for (const c of cat.docs) sections.push(bullet(c));
    sections.push("");
  }
  if (cat.other.length > 0) {
    sections.push("### Other");
    for (const c of cat.other) sections.push(bullet(c));
    sections.push("");
  }
  if (commits.length === 0) {
    sections.push("_(No commits found in the window. Either nothing shipped today, or the script needs a different `--since`.)_");
    sections.push("");
  }

  sections.push("---");
  sections.push("");
  sections.push("## Conversational Context (FILL IN — this is the part that matters tomorrow)");
  sections.push("");
  sections.push("Things you told me in this session that aren't in the code or git history.");
  sections.push("Examples: deadlines, who you're meeting with, decisions made verbally,");
  sections.push("things you ruled out and why.");
  sections.push("");
  sections.push("- ");
  sections.push("");
  sections.push("---");
  sections.push("");
  sections.push("## Open Items / What's Next");
  sections.push("");
  sections.push("- ");
  sections.push("");
  sections.push("---");
  sections.push("");
  // Prompt retrospective. Placed BEFORE the blockers so it is read while the
  // session is still fresh, and scaffolded as a filled-in template rather than
  // an empty heading — an empty heading is a section that gets skipped.
  // The taxonomy and the analysis live in src/lib/session-retro.ts, tested.
  sections.push("## Prompt Retrospective (FILL IN — one line each)");
  sections.push("");
  sections.push("_What would have got this session done in fewer rounds? The value is the");
  sections.push("PATTERN across sessions, not the score of any one. Tick the causes that");
  sections.push("applied; leave the rest._");
  sections.push("");
  sections.push("- **The ask:** _(what was requested, in the operator's words)_");
  sections.push("- **Rounds to done:** _(count of operator messages)_");
  sections.push("");
  sections.push("| Cause | Applied? | The sentence that would have carried it |");
  sections.push("| --- | --- | --- |");
  sections.push("| unstated-target | | Name the repo and branch in the first sentence. |");
  sections.push("| unstated-constraint | | State the constraint up front rather than as a correction. |");
  sections.push("| unstated-done | | Say what you will check to decide it is done. |");
  sections.push("| assumed-context | | Paste the fact, or say where to find it. |");
  sections.push("| scope-discovered | | Nothing — this is the good kind of round. |");
  sections.push("| agent-error | | Nothing — this one is the agent's, and belongs in a guardrail. |");
  sections.push("");
  sections.push("**The one-shot version of this request:**");
  sections.push("");
  sections.push("> _(Rewrite the ask so it would have worked first time. This line is the");
  sections.push("> deliverable — it is what gets reused.)_");
  sections.push("");
  sections.push("---");
  sections.push("");
  sections.push("## Known Blockers");
  sections.push("");
  sections.push("- ");
  sections.push("");
  sections.push("---");
  sections.push("");
  sections.push("## How to Resume");
  sections.push("");
  sections.push("```bash");
  sections.push("cd /Users/nicholashomyk/mono/wolfpack-apex");
  sections.push("git pull");
  sections.push("npx jest --no-coverage");
  sections.push("```");
  sections.push("");

  return sections.join("\n");
}

function main() {
  const date = todayIso();
  const targetPath = resolve(DEMO_DIR, `handoff-${date}.md`);

  const latest = findLatestHandoff();
  // git log --since accepts a YYYY-MM-DD
  const commits = gitLogSince(latest?.date || null);
  const body = buildHandoff(date, latest, commits);

  // Atomic exists-then-write via the `wx` flag (CodeQL:
  // js/file-system-race). Replaces the existsSync + writeFileSync
  // TOCTOU sequence — `wx` makes writeFileSync throw EEXIST when the
  // file is already present, which is the "do not clobber" path.
  try {
    writeFileSync(targetPath, body, { encoding: "utf-8", flag: "wx" });
  } catch (err) {
    if (err && err.code === "EEXIST") {
      console.log(`Handoff already exists: ${targetPath}`);
      console.log("Refusing to overwrite. Edit it directly or delete + re-run.");
      process.exit(0);
    }
    throw err;
  }
  console.log(`Handoff scaffold written: ${targetPath}`);
  console.log(`  ${commits.length} commit(s) captured`);
  if (latest) console.log(`  Previous handoff: ${latest.name}`);
  console.log("");
  console.log("Next: open the file and fill in:");
  console.log("  1. Headline (one sentence)");
  console.log("  2. Conversational Context (the part git can't see)");
  console.log("  3. Open Items / What's Next");
  console.log("  4. Known Blockers");
}

main();
