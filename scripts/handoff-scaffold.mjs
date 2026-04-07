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
import { execSync } from "node:child_process";
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
  try {
    const arg = sinceDate ? `--since=${sinceDate}` : `--since="24 hours ago"`;
    const out = execSync(
      `git -C "${REPO_ROOT}" log ${arg} --pretty=format:"%h|%s" --no-merges`,
      { encoding: "utf-8" },
    );
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
    return execSync(`git -C "${REPO_ROOT}" rev-parse --short HEAD`, { encoding: "utf-8" }).trim();
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

  if (existsSync(targetPath)) {
    console.log(`Handoff already exists: ${targetPath}`);
    console.log("Refusing to overwrite. Edit it directly or delete + re-run.");
    process.exit(0);
  }

  const latest = findLatestHandoff();
  // git log --since accepts a YYYY-MM-DD
  const commits = gitLogSince(latest?.date || null);
  const body = buildHandoff(date, latest, commits);

  writeFileSync(targetPath, body, "utf-8");
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
