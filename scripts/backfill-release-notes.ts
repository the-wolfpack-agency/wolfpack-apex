/**
 * backfill-release-notes.ts: one-time (idempotent) import of the existing
 * hand-authored demo/release-report-*.md files across the Wolfpack repos into
 * the /releases page (instinct_releases).
 *
 * Deterministic markdown parse (no AI, no reword): each report becomes one
 * release, tagged by product area, with its section headings as feature
 * entries so the page reflects the real shipped history. Re-runnable: releases
 * upsert on version = "<area>-<date>".
 *
 * Usage:
 *   npm run release:backfill -- [--dry-run]
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createRelease, type ReleaseEntry } from "@/lib/releases";

/** Repos to scan. `area` tags each entry so one page shows all projects. */
const SOURCES: { area: string; dir: string }[] = [
  { area: "Instinct", dir: "/Users/nicholashomyk/mono/wolfpack-apex/demo" },
  { area: "Auto", dir: "/Users/nicholashomyk/mono/wolfpack-auto/demo" },
  { area: "LMS", dir: "/Users/nicholashomyk/mono/wolfpack-lms/demo" },
];

/** H2 sections that are meta/process, not shipped features, skipped as entries. */
const META = [
  "tl;dr", "tldr", "numbers", "operational", "carry-forward", "carry forward",
  "next-session", "next session", "standing reminders", "reminders",
  "verification", "branch and deploy", "deploy state", "table of contents",
  "how to read", "session hygiene", "pending", "blockers",
];

function isMeta(heading: string): boolean {
  const h = heading.toLowerCase();
  return META.some((m) => h.includes(m));
}

function categoryFor(heading: string): string {
  const h = heading.toLowerCase();
  if (/\bfix|bug|hotfix\b/.test(h)) return "fix";
  if (/\bfeature|new\b/.test(h)) return "feature";
  return "improvement";
}

/** Flatten a section body (bullets/paragraphs) into a short plain description. */
function flatten(lines: string[]): string {
  const text = lines
    .join("\n")
    .replace(/```[\s\S]*?```/g, "")            // drop code fences
    .replace(/^[-*]\s+/gm, "")                  // strip bullet markers
    .replace(/[`*_#>]/g, "")                    // strip md emphasis/heading chars
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")    // links -> text
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 500 ? text.slice(0, 497).trimEnd() + "…" : text;
}

interface Parsed {
  title: string;
  summary: string;
  entries: ReleaseEntry[];
}

/** Deterministic parse of one release-report markdown into a release. */
function parseReport(md: string, area: string, date: string): Parsed {
  const lines = md.split("\n");

  const h1 = lines.find((l) => /^#\s+/.test(l));
  const title = h1 ? h1.replace(/^#\s+/, "").trim() : `${area} release ${date}`;

  // Collect H2 sections: { heading, bodyLines }.
  const sections: { heading: string; body: string[] }[] = [];
  let cur: { heading: string; body: string[] } | null = null;
  for (const l of lines) {
    const m2 = l.match(/^##\s+(.+)/);
    if (m2) {
      if (cur) sections.push(cur);
      cur = { heading: m2[1].trim(), body: [] };
    } else if (cur) {
      cur.body.push(l);
    }
  }
  if (cur) sections.push(cur);

  const tldr = sections.find((s) => /tl;?dr/i.test(s.heading));
  const summary = tldr
    ? flatten(tldr.body)
    : flatten(sections[0]?.body ?? lines.slice(0, 12));

  const entries: ReleaseEntry[] = [];
  for (const s of sections) {
    if (isMeta(s.heading)) continue;
    // Prefer H3 subsections as individual entries; else the H2 itself.
    const h3s: { heading: string; body: string[] }[] = [];
    let sub: { heading: string; body: string[] } | null = null;
    for (const l of s.body) {
      const m3 = l.match(/^###\s+(.+)/);
      if (m3) {
        if (sub) h3s.push(sub);
        sub = { heading: m3[1].trim(), body: [] };
      } else if (sub) {
        sub.body.push(l);
      }
    }
    if (sub) h3s.push(sub);

    if (h3s.length > 0) {
      for (const h of h3s) {
        const desc = flatten(h.body);
        if (!desc && !h.heading) continue;
        entries.push({ title: h.heading, description: desc, how_to_use: "", area, category: categoryFor(h.heading) });
      }
    } else {
      const desc = flatten(s.body);
      if (desc) entries.push({ title: s.heading, description: desc, how_to_use: "", area, category: categoryFor(s.heading) });
    }
  }

  return { title, summary, entries };
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  if (!dryRun && !process.env.DATABASE_URL) {
    console.error("[backfill] DATABASE_URL not set; use --dry-run to preview.");
    process.exit(1);
  }

  let count = 0;
  for (const { area, dir } of SOURCES) {
    if (!existsSync(dir)) continue;
    const files = readdirSync(dir)
      .filter((f) => /^release-report-\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .sort();
    for (const f of files) {
      const date = f.slice("release-report-".length, "release-report-".length + 10);
      const md = readFileSync(join(dir, f), "utf8");
      const { title, summary, entries } = parseReport(md, area, date);
      const version = `${area.toLowerCase()}-${date}`;
      if (dryRun) {
        console.log(`\n=== ${version}: ${title} (${entries.length} entries) ===`);
        console.log(summary.slice(0, 160));
        continue;
      }
      await createRelease({ version, title, summary, released_on: date, entries, created_by: "backfill" });
      count++;
      console.log(`[backfill] ${version}: "${title}" (${entries.length} entries)`);
    }
  }
  console.log(dryRun ? "[backfill] dry-run complete." : `[backfill] imported ${count} release(s).`);
}

main().catch((err) => {
  console.error("[backfill] failed:", err);
  process.exit(1);
});
