/**
 * backfill-release-notes.ts: one-time (idempotent) import of Wolfpack product
 * history into the /releases page (instinct_releases), so the timeline shows:
 *   - when each product was created (first commit / repo creation), and
 *   - every hand-authored release report across the repos (feature-facing only;
 *     internal session handoffs are deliberately excluded).
 *
 * Deterministic markdown parse (no AI reword of historical records). Re-runnable:
 * everything upserts on a stable version key.
 *
 * Usage: npm run release:backfill -- [--dry-run]
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { createRelease, type ReleaseEntry } from "@/lib/releases";

const MONO = "/Users/nicholashomyk/mono";

/**
 * Every Wolfpack product. `dir` is the local repo folder (null = remote-only,
 * e.g. OGIAM which is not cloned here, so we still place its creation milestone
 * using the GitHub repo creation date). Reports/handoffs are read from local
 * repos only.
 */
const PRODUCTS: { area: string; dir: string | null; createdOn?: string; slug?: string }[] = [
  { area: "AgenticQA", dir: "AgenticQA" },
  { area: "Auto", dir: "wolfpack-auto" },
  { area: "Instinct", dir: "wolfpack-apex" },
  { area: "LMS", dir: "wolfpack-lms" },
  // Weekend is intentionally excluded: it duplicates Porsche Weekend (its live
  // instance), so it was removed from /products and de-duped here too.
  { area: "Aidan Mulready", dir: "wolfpack-aidan-mulready" },
  { area: "Beyond", dir: "wolfpack-beyond" },
  // Display name renamed to "Porsche Extended Ownership Experience"; the slug is
  // pinned to the original so the existing instinct_releases rows upsert in place
  // (no duplicate milestone) rather than creating a new versioned entry.
  { area: "Porsche Extended Ownership Experience", dir: "wolfpack-porsche-weekend", slug: "porsche-weekend" },
  // Display name "OGIAM IAM" (the product), distinct from OGIAM the tech branch.
  // Slug pinned to the original so the existing milestone row upserts in place.
  { area: "OGIAM IAM", dir: null, createdOn: "2026-06-15", slug: "ogiam" },
];

/** Folders within a repo that may hold reports/handoffs. */
const DOC_DIRS = ["demo", "docs"];

// Section headings that are meta/process/internal, NOT shipped features.
// The page is team-facing, so anything that reads like a session retrospective,
// coaching note, blocker list, or deploy log is excluded.
const META = [
  "tl;dr", "tldr", "numbers", "operational", "carry-forward", "carry forward",
  "next-session", "next session", "standing reminders", "reminders",
  "verification", "branch and deploy", "deploy state", "table of contents",
  "how to read", "session hygiene", "pending", "blockers", "blocker",
  "lessons", "lesson", "retro", "retrospective", "coaching", "feedback",
  "what went wrong", "went wrong", "landmine", "post-mortem", "postmortem",
  "known issue", "gotcha", "mistake", "what i learned", "learnings",
  "do not", "never ", "rules", "context that git", "conversational context",
  "outstanding", "next up", "still to do", "remaining work",
];

const slug = (area: string) => area.toLowerCase().replace(/\s+/g, "-");
const isMeta = (h: string) => META.some((m) => h.toLowerCase().includes(m));

/** Strip em/en dashes from imported copy (the reports use them; the page must
 *  not). A spaced dash becomes the given separator; any other becomes a hyphen.
 *  Dash chars are built by char code so this source file itself stays dash-free. */
const DASH_CLASS = `[${String.fromCharCode(0x2014)}${String.fromCharCode(0x2013)}]`;
const stripDash = (s: string, sep = ", ") =>
  s
    .replace(new RegExp(`\\s${DASH_CLASS}\\s`, "g"), sep)
    .replace(new RegExp(DASH_CLASS, "g"), "-");

function categoryFor(heading: string): string {
  const h = heading.toLowerCase();
  if (/\bfix|bug|hotfix\b/.test(h)) return "fix";
  if (/\bfeature|new\b/.test(h)) return "feature";
  return "improvement";
}

function flatten(lines: string[]): string {
  const text = lines
    .join("\n")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/^[-*]\s+/gm, "")
    .replace(/[`*_#>]/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  const clean = stripDash(text);
  return clean.length > 500 ? clean.slice(0, 497).trimEnd() + "…" : clean;
}

interface Parsed { title: string; summary: string; entries: ReleaseEntry[] }

function parseReport(md: string, area: string, fallbackTitle: string): Parsed {
  const lines = md.split("\n");
  const h1 = lines.find((l) => /^#\s+/.test(l));
  const title = stripDash(h1 ? h1.replace(/^#\s+/, "").trim() : fallbackTitle, ": ");

  const sections: { heading: string; body: string[] }[] = [];
  let cur: { heading: string; body: string[] } | null = null;
  for (const l of lines) {
    const m = l.match(/^##\s+(.+)/);
    if (m) {
      if (cur) sections.push(cur);
      cur = { heading: m[1].trim(), body: [] };
    } else if (cur) cur.body.push(l);
  }
  if (cur) sections.push(cur);

  const tldr = sections.find((s) => /tl;?dr/i.test(s.heading));
  const summary = tldr ? flatten(tldr.body) : flatten(sections[0]?.body ?? lines.slice(0, 12));

  const entries: ReleaseEntry[] = [];
  for (const s of sections) {
    if (isMeta(s.heading)) continue;
    const h3s: { heading: string; body: string[] }[] = [];
    let sub: { heading: string; body: string[] } | null = null;
    for (const l of s.body) {
      const m = l.match(/^###\s+(.+)/);
      if (m) {
        if (sub) h3s.push(sub);
        sub = { heading: m[1].trim(), body: [] };
      } else if (sub) sub.body.push(l);
    }
    if (sub) h3s.push(sub);

    if (h3s.length > 0) {
      for (const h of h3s) {
        const desc = flatten(h.body);
        if (!h.heading) continue;
        entries.push({ title: stripDash(h.heading, ": "), description: desc, how_to_use: "", area, category: categoryFor(h.heading) });
      }
    } else {
      const desc = flatten(s.body);
      if (desc) entries.push({ title: stripDash(s.heading, ": "), description: desc, how_to_use: "", area, category: categoryFor(s.heading) });
    }
  }
  return { title, summary, entries };
}

/** First-commit (creation) date of a local repo, YYYY-MM-DD, or null. */
function creationDate(dir: string): string | null {
  try {
    return execSync(`git -C ${join(MONO, dir)} log --reverse --format=%ad --date=short`, { encoding: "utf8" })
      .split("\n")[0]
      ?.trim() || null;
  } catch {
    return null;
  }
}

/** Lines of source code tracked by git in a repo (excludes node_modules and
 *  other gitignored artifacts automatically). Best-effort; 0 on failure. */
function linesOfCode(dir: string): number {
  try {
    // Concatenate all tracked source files then count once, so the total is not
    // truncated by xargs batching. Exclude vendored/generated trees + type defs
    // so the number reflects team-authored code. git ls-files already skips
    // gitignored paths (node_modules, .next, dist).
    const cmd =
      `cd '${join(MONO, dir)}' && git ls-files -z -- ` +
      `'*.ts' '*.tsx' '*.js' '*.jsx' '*.mjs' '*.cjs' '*.py' '*.sql' '*.css' '*.scss' ` +
      `| grep -zvE '(^|/)(vendor|dist|build|coverage|__generated__)/|\\.d\\.ts$|\\.min\\.(js|css)$' ` +
      `| xargs -0 cat 2>/dev/null | wc -l`;
    const out = execSync(cmd, { encoding: "utf8", maxBuffer: 512 * 1024 * 1024, shell: "/bin/bash" });
    return parseInt(out.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

interface Publish { version: string; title: string; summary: string; released_on: string; entries: ReleaseEntry[] }

function collect(): Publish[] {
  const out: Publish[] = [];
  for (const p of PRODUCTS) {
    const s = p.slug ?? slug(p.area);

    // 1. Creation milestone.
    const created = p.dir ? creationDate(p.dir) : p.createdOn ?? null;
    if (created) {
      const loc = p.dir ? linesOfCode(p.dir) : 0;
      const locNote = loc ? ` with ~${loc.toLocaleString()} lines of code` : "";
      out.push({
        version: `${s}-created`,
        title: `${p.area} created`,
        summary: `${p.area} was created on ${created}${locNote}.`,
        released_on: created,
        entries: [{ title: `${p.area} project created`, description: `First commit / repo inception for ${p.area}${locNote}.`, how_to_use: "", area: p.area, category: "milestone", loc }],
      });
    }

    if (!p.dir) continue;

    // 2. Release reports only, from demo/ and docs/. Handoffs are internal
    //    session working notes (retrospectives, blockers, coaching, next-step
    //    TODOs) and are intentionally NOT surfaced on the team-facing page.
    for (const sub of DOC_DIRS) {
      const dir = join(MONO, p.dir, sub);
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir)) {
        const rr = f.match(/^release-report-(\d{4}-\d{2}-\d{2})\.md$/i);
        if (!rr) continue;
        const date = rr[1];
        const md = readFileSync(join(dir, f), "utf8");
        const parsed = parseReport(md, p.area, `${p.area} release ${date}`);
        out.push({
          version: `${s}-${date}`,
          title: parsed.title,
          summary: parsed.summary,
          released_on: date,
          entries: parsed.entries,
        });
      }
    }
  }
  return out;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  if (!dryRun && !process.env.DATABASE_URL) {
    console.error("[backfill] DATABASE_URL not set; use --dry-run to preview.");
    process.exit(1);
  }

  const items = collect().sort((a, b) => (a.released_on < b.released_on ? 1 : -1));
  let n = 0;
  for (const it of items) {
    if (dryRun) {
      console.log(`${it.released_on}  ${it.version}  ${it.title} (${it.entries.length})`);
      continue;
    }
    await createRelease({ ...it, created_by: "backfill" });
    n++;
  }
  console.log(dryRun ? `[backfill] ${items.length} item(s) (dry-run).` : `[backfill] imported ${n} item(s).`);
}

main().catch((err) => {
  console.error("[backfill] failed:", err);
  process.exit(1);
});
