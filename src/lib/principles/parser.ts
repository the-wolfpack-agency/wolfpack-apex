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

/* mammoth was previously used here for docx→markdown but its internal
 * XML parser broke against the repo's @xmldom/xmldom 0.9.x override.
 * Replaced with a direct JSZip + regex extractor below. */

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
 * Convert a .docx buffer to markdown directly.
 *
 * History: this used to delegate to mammoth.convertToMarkdown, but
 * mammoth's internal XML parsing breaks against the @xmldom/xmldom
 * 0.9.x version this repo overrides to (mammoth was written against
 * 0.8.x; the 0.9 release made the mimeType arg required for
 * DOMParser.parseFromString and mammoth never updated its call sites).
 * Production hit this with the error
 *   "DOMParser.parseFromString: the provided mimeType 'undefined'
 *    is not valid"
 * on every sync.
 *
 * Direct extractor: a .docx is a ZIP with `word/document.xml` as the
 * body. Open via JSZip (already in the dep tree as a transitive),
 * walk paragraphs, detect heading styles + bold runs, and emit the
 * minimal markdown surface our marker parser needs:
 *   - Heading 2 paragraphs → `## ...`
 *   - Bold runs → wrapped in `**...**`
 *   - Other paragraphs → plain text
 *   - Empty paragraphs → blank line
 *
 * No DOMParser, no xmldom, no mammoth. Pure regex over the doc XML.
 */
export async function docxBufferToMarkdown(buf: Buffer): Promise<string> {
  /* Dynamic import — JSZip is a CommonJS module surfaced transitively;
     a top-level import would force a build-time include. */
  const JSZipMod = (await import("jszip")).default;
  const zip = await JSZipMod.loadAsync(buf);
  const docFile = zip.file("word/document.xml");
  if (!docFile) {
    throw new Error("not a valid .docx (missing word/document.xml)");
  }
  const xml = await docFile.async("string");
  return docXmlToMarkdown(xml);
}

/**
 * Pure-string converter: word/document.xml → markdown. Exported for
 * unit testing without needing a real .docx fixture.
 */
export function docXmlToMarkdown(xml: string): string {
  /* Walk paragraphs in order. Each `<w:p ...>...</w:p>` block is one
     line of output. Inline runs (`<w:r>...</w:r>`) carry the actual
     text + formatting (bold). */
  const paraRe = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g;
  const lines: string[] = [];
  let pMatch: RegExpExecArray | null;
  while ((pMatch = paraRe.exec(xml)) !== null) {
    const inner = pMatch[1];
    /* Heading style — emit ## for Heading2, # for Heading1, ### for 3.
       Word stores it as `<w:pStyle w:val="Heading2"/>` (or just the
       template name like "heading 2"). Tolerant. */
    const styleMatch = /<w:pStyle\s+w:val="([^"]*)"/i.exec(inner);
    const style = (styleMatch?.[1] ?? "").toLowerCase().replace(/\s+/g, "");
    let prefix = "";
    if (style === "heading1") prefix = "# ";
    else if (style === "heading2") prefix = "## ";
    else if (style === "heading3") prefix = "### ";

    /* Walk runs to collect text, wrapping bold runs in **...**. */
    const runRe = /<w:r\b[^>]*>([\s\S]*?)<\/w:r>/g;
    const segments: string[] = [];
    let rMatch: RegExpExecArray | null;
    while ((rMatch = runRe.exec(inner)) !== null) {
      const runInner = rMatch[1];
      const isBold = /<w:b\b/.test(runInner);
      /* Concatenate every <w:t>...</w:t> in this run. Multiple <w:t>
         elements appear when Word splits a single styled run across
         language/formatting boundaries; they belong to the same run
         visually. */
      const texts: string[] = [];
      const textRe = /<w:t[^>]*>([\s\S]*?)<\/w:t>/g;
      let tMatch: RegExpExecArray | null;
      while ((tMatch = textRe.exec(runInner)) !== null) {
        texts.push(decodeXmlEntities(tMatch[1]));
      }
      const tabRe = /<w:tab\b[^>]*\/>/g;
      const text = texts.join("");
      if (!text) {
        if (tabRe.test(runInner)) segments.push("\t");
        continue;
      }
      /* Avoid `**...**` wrapping when the run is whitespace-only —
         that produces `** **` artifacts that confuse our marker
         parser. */
      if (isBold && text.trim()) {
        segments.push(`**${text}**`);
      } else {
        segments.push(text);
      }
    }
    const lineText = segments.join("");
    if (prefix) {
      lines.push(`${prefix}${lineText.trim()}`);
    } else {
      lines.push(lineText);
    }
  }
  /* Collapse 3+ consecutive blank lines down to a single blank line
     — Word emits empty paragraphs liberally and the marker parser
     prefers a clean prose body. */
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
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
