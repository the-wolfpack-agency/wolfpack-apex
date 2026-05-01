/**
 * Principles parser — SharePoint .docx → structured principle records.
 *
 * Convention. Hoxsie + Nick author principles in a SharePoint Word doc
 * with a light marker convention so prose stays human-readable but the
 * machine-readable bits are deterministic to extract:
 *
 *   ## Principle: Ship before perfect
 *   **Domain:** code, comms
 *   **Owner:** Hoxsie
 *   **Effective:** 2026-05-01
 *   **Scoreboard weight:** 3
 *
 *   <free prose: the why, the story, the anti-pattern…>
 *
 *   **Signal:** PR cycle time < 48h
 *   **Signal:** No more than 2 reviewers requested per PR
 *   **Counter-signal:** PRs sitting open >5 days without comments
 *
 * Required: `## Principle: <title>`. Everything else is optional;
 * unrecognized fields surface as `parseWarnings` but never block.
 *
 * Zero-token by design — pure string parsing. mammoth converts the
 * .docx to markdown; we walk it linearly. No AI on the hot path; the
 * cron job runs at zero marginal cost (per the global invariant
 * `feedback_zero_tokens_first`).
 */

import mammoth from "mammoth";

/** A single principle as Hoxsie writes it, normalized for storage. */
export interface ParsedPrinciple {
  /** URL-safe slug derived from the title. */
  slug: string;
  title: string;
  /** Domain tags. Free-form here; the validator framework matches them
   *  against its registered surfaces (calendar/mail/code/...). */
  domains: string[];
  owner: string | null;
  /** ISO date the principle takes effect (when set). */
  effectiveAt: string | null;
  /** 1–5; defaults to 1 if unset. Higher = more weight in scoreboard. */
  scoreboardWeight: number;
  /** Free-prose body (markdown), with the field markers stripped. */
  bodyMd: string;
  /** Positive observable patterns. Each entry is the raw description
   *  Hoxsie wrote — the validator framework maps these to signal ids
   *  in a separate registry. */
  signals: string[];
  /** Anti-patterns the principle wants to discourage. */
  counterSignals: string[];
}

export interface ParseResult {
  principles: ParsedPrinciple[];
  /** Per-section parser warnings — surface to the UI so Hoxsie sees
   *  them without breaking the sync. */
  warnings: string[];
  /** sha256 hex of the input bytes — change-detect for the sync job. */
  sourceHash: string;
}

/* ------------------------------------------------------------------ */
/* docx → markdown                                                     */
/* ------------------------------------------------------------------ */

/**
 * Convert a .docx buffer to markdown via mammoth. Mammoth preserves
 * heading levels, bold/italic, and lists, which is exactly what our
 * marker convention needs. Images + footnotes are dropped (we never
 * read them anyway).
 */
export async function docxBufferToMarkdown(buf: Buffer): Promise<string> {
  /* mammoth's TS types are incomplete — convertToMarkdown exists at
     runtime in v1.x but the @types/mammoth surface only covers
     convertToHtml + extractRawText. Cast for the call only. */
  const m = mammoth as unknown as {
    convertToMarkdown: (opts: { buffer: Buffer }) => Promise<{ value: string }>;
  };
  const result = await m.convertToMarkdown({ buffer: buf });
  return result.value;
}

/* ------------------------------------------------------------------ */
/* sha256 hash (Node-only; the sync job runs server-side)              */
/* ------------------------------------------------------------------ */

import { createHash } from "node:crypto";

export function sha256Hex(buf: Buffer | string): string {
  return createHash("sha256")
    .update(typeof buf === "string" ? Buffer.from(buf) : buf)
    .digest("hex");
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/** Split markdown into top-level sections delimited by `## ` (level 2)
 *  headings. Anything before the first `## ` is preamble and ignored. */
function splitIntoSections(md: string): string[] {
  const lines = md.split(/\r?\n/);
  const sections: string[] = [];
  let current: string[] = [];
  let inSection = false;
  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      if (inSection) sections.push(current.join("\n"));
      current = [line];
      inSection = true;
    } else if (inSection) {
      current.push(line);
    }
  }
  if (inSection && current.length) sections.push(current.join("\n"));
  return sections;
}

/** Match a `**Field:** value` line, case-insensitive. Tolerant of both
 *  `**Field:** value` (colon inside bold) and `**Field**: value`
 *  (colon outside bold) — Word's markdown export emits the former,
 *  hand-typed markdown often emits the latter. */
function extractField(section: string, field: string): string | null {
  const re = new RegExp(
    `^\\s*\\*\\*${field}\\s*:?\\s*\\*\\*\\s*:?\\s*(.+?)\\s*$`,
    "im",
  );
  const m = re.exec(section);
  return m ? m[1].trim() : null;
}

/** Same tolerance, repeated occurrences. */
function extractAllFields(section: string, field: string): string[] {
  const re = new RegExp(
    `^\\s*\\*\\*${field}\\s*:?\\s*\\*\\*\\s*:?\\s*(.+?)\\s*$`,
    "gim",
  );
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(section)) !== null) {
    const v = m[1].trim();
    if (v) out.push(v);
  }
  return out;
}

/** Strip every field-marker line from the section to leave the prose
 *  body. Same tolerance as extractField. */
function stripFieldLines(section: string): string {
  return section
    .split(/\r?\n/)
    .filter(
      (l) => !/^\s*\*\*[A-Za-z][A-Za-z\- ]+\s*:?\s*\*\*\s*:?/.test(l),
    )
    .join("\n")
    .replace(/^\s*\n+/, "")
    .replace(/\n+\s*$/, "");
}

/* ------------------------------------------------------------------ */
/* Section → ParsedPrinciple                                           */
/* ------------------------------------------------------------------ */

interface ParseSectionResult {
  principle: ParsedPrinciple | null;
  warnings: string[];
}

/**
 * Parse a single `## Principle: <title>` section. Returns the
 * principle plus any non-fatal warnings (unknown fields, bad date,
 * etc). Returns `null` if the section isn't a Principle section
 * (e.g. an unrelated `## Background` block in the doc).
 */
export function parseSection(section: string): ParseSectionResult {
  /* Match "## Principle:" with possibly-empty title so we can warn
     when the title is missing rather than silently dropping the
     section as "not a principle". */
  const headingMatch = /^##\s+Principle:\s*(.*?)\s*$/im.exec(section);
  if (!headingMatch) return { principle: null, warnings: [] };

  const title = headingMatch[1].trim();
  if (!title) {
    return {
      principle: null,
      warnings: ["Principle section has empty title — skipping"],
    };
  }

  const warnings: string[] = [];
  const bodyAfterHeading = section.replace(headingMatch[0], "").replace(/^\s*\n*/, "");

  /* Domain — comma-separated tags. Required only in spirit; if absent
     we tag ['cross_cutting'] so the validator framework still fires. */
  const domainRaw = extractField(bodyAfterHeading, "Domain");
  const domains = domainRaw
    ? domainRaw
        .split(/[,、　]+/)
        .map((d) => d.trim().toLowerCase())
        .filter(Boolean)
    : ["cross_cutting"];
  if (!domainRaw) {
    warnings.push(`Principle '${title}' has no Domain — defaulted to cross_cutting`);
  }

  const owner = extractField(bodyAfterHeading, "Owner");

  /* Effective date — accept ISO (2026-05-01) or natural ("May 1, 2026").
     We attempt Date.parse; on failure, warn but don't block. */
  const effectiveRaw = extractField(bodyAfterHeading, "Effective");
  let effectiveAt: string | null = null;
  if (effectiveRaw) {
    const parsed = Date.parse(effectiveRaw);
    if (Number.isFinite(parsed)) {
      effectiveAt = new Date(parsed).toISOString().slice(0, 10);
    } else {
      warnings.push(
        `Principle '${title}': could not parse Effective date "${effectiveRaw}" — left null`,
      );
    }
  }

  /* Scoreboard weight — clamp 1..5. */
  const weightRaw = extractField(bodyAfterHeading, "Scoreboard weight");
  let scoreboardWeight = 1;
  if (weightRaw) {
    const n = Number(weightRaw);
    if (Number.isFinite(n) && n >= 1 && n <= 5) {
      scoreboardWeight = Math.round(n);
    } else {
      warnings.push(
        `Principle '${title}': Scoreboard weight "${weightRaw}" outside 1–5 — defaulted to 1`,
      );
    }
  }

  const signals = extractAllFields(bodyAfterHeading, "Signal");
  const counterSignals = extractAllFields(bodyAfterHeading, "Counter-signal");

  if (signals.length === 0 && counterSignals.length === 0) {
    warnings.push(
      `Principle '${title}' has no Signal or Counter-signal — descriptive only, will not generate observations`,
    );
  }

  const bodyMd = stripFieldLines(bodyAfterHeading);

  return {
    principle: {
      slug: slugify(title),
      title,
      domains,
      owner,
      effectiveAt,
      scoreboardWeight,
      bodyMd,
      signals,
      counterSignals,
    },
    warnings,
  };
}

/* ------------------------------------------------------------------ */
/* Top-level                                                           */
/* ------------------------------------------------------------------ */

/**
 * Parse a whole markdown document. Splits into `## ...` sections, runs
 * each through parseSection, dedupes by slug (later definitions win
 * with a warning), and sha256s the input bytes for the sync job.
 */
export function parseMarkdown(md: string, sourceBytes?: Buffer): ParseResult {
  const sections = splitIntoSections(md);
  const principles: ParsedPrinciple[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();

  for (const section of sections) {
    const { principle, warnings: sectionWarnings } = parseSection(section);
    warnings.push(...sectionWarnings);
    if (!principle) continue;
    if (seen.has(principle.slug)) {
      warnings.push(
        `Duplicate principle slug "${principle.slug}" — keeping later definition, dropping earlier one`,
      );
      const idx = principles.findIndex((p) => p.slug === principle.slug);
      if (idx >= 0) principles.splice(idx, 1);
    }
    seen.add(principle.slug);
    principles.push(principle);
  }

  return {
    principles,
    warnings,
    sourceHash: sha256Hex(sourceBytes ?? md),
  };
}

/** Convenience: parse a .docx buffer end-to-end. Use this from the
 *  Microsoft Graph fetcher in production. */
export async function parseDocxBuffer(buf: Buffer): Promise<ParseResult> {
  const md = await docxBufferToMarkdown(buf);
  return parseMarkdown(md, buf);
}
