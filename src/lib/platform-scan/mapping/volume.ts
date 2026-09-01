/**
 * How much of a thing a system holds, and whether the export exists to move it.
 *
 * WHAT THESE TWO ANSWER. A map that lists the business objects tells somebody
 * WHAT a system holds. Scoping a rollout needs two more things: how much of
 * each, because an object with forty records and one with four hundred
 * thousand are different projects, and whether the data can be got out at all,
 * because that decides integrate against migrate before anybody estimates
 * either.
 *
 * Both were left to somebody opening every screen by hand.
 *
 * A COUNT IS READ, NEVER INFERRED. The number comes from a phrase the system
 * itself displays: a pager saying "1-25 of 347", a total saying "347 entries".
 * Counting rows on screen would report the page size and call it the estate,
 * which is the confident kind of wrong that survives into an estimate.
 *
 * NO COUNT IS NOT ZERO. A screen that shows no total leaves this null, and
 * null is reported as unknown everywhere it surfaces. "This object holds
 * nothing" and "this screen did not say" are opposite facts and a migration
 * plan built on the wrong one is wrong by the whole object.
 *
 * THE EXPORT IS DETECTED, NEVER PRESSED. An export button is an affordance we
 * report; clicking it would download somebody's data onto our machine, which
 * is the one thing a read-only scan must not do. Whether it works is a
 * question for the engagement, and its presence is what changes the plan.
 */

/** A quantity a screen stated about itself. */
export interface VolumeReading {
  /** Records the system says it holds, or null when nothing said. */
  total: number | null;
  /** The phrase it was read from, so a reviewer can check rather than trust. */
  from: string | null;
}

/**
 * Read a total from the phrases a screen displayed.
 *
 * Prefers "x-y of N", because a pager states the estate while a bare number
 * beside a noun may be the page. Falls back to the largest stated quantity,
 * which is the safer direction: understating volume is what produces an
 * estimate somebody has to renegotiate.
 */
export function readVolume(phrases: readonly string[]): VolumeReading {
  const num = (s: string) => Number(s.replace(/,/g, ""));

  for (const phrase of phrases) {
    const pager = /\b\d[\d,]*\s*(?:-|to|–)\s*\d[\d,]*\s+of\s+(\d[\d,]*)\b/i.exec(phrase);
    if (pager) return { total: num(pager[1]), from: phrase };
  }

  let best: VolumeReading = { total: null, from: null };
  for (const phrase of phrases) {
    const m = /(\d[\d,]*)/.exec(phrase);
    if (!m) continue;
    const value = num(m[1]);
    if (!Number.isFinite(value)) continue;
    if (best.total === null || value > best.total) best = { total: value, from: phrase };
  }
  return best;
}

/**
 * Ways data appears to be gettable out of this system.
 *
 * Read from the controls and links a screen already offered, so nothing extra
 * is touched to find them.
 */
export type ExportKind = "download" | "api" | "print";

export interface ExportAffordance {
  kind: ExportKind;
  /** What the control or link called itself. */
  label: string;
}

const EXPORT_PATTERNS: Array<{ kind: ExportKind; match: RegExp }> = [
  /* Deliberately narrow. "Export", "download", a named file format. A looser
     rule matches "save" and "send", which are writes, and a scan that
     reported a send button as an export route would be describing a way data
     leaves that nobody asked for. */
  { kind: "download", match: /\b(?:export|download|csv|xlsx?|\.zip|spreadsheet)\b/i },
  { kind: "api", match: /\b(?:api|webhook|integration key|developer)\b/i },
  { kind: "print", match: /\bprint\b/i },
];

export function findExports(
  labels: readonly string[],
  links: readonly string[] = [],
): ExportAffordance[] {
  const found: ExportAffordance[] = [];
  const seen = new Set<string>();

  const consider = (text: string) => {
    const clean = text.replace(/\s+/g, " ").trim();
    if (!clean || clean.length > 80) return;
    for (const p of EXPORT_PATTERNS) {
      if (!p.match.test(clean)) continue;
      const key = `${p.kind}:${clean.toLowerCase()}`;
      if (seen.has(key)) return;
      seen.add(key);
      found.push({ kind: p.kind, label: clean.slice(0, 60) });
      return;
    }
  };

  for (const l of labels) consider(l);
  /* A link's PATH, not the whole URL: a query string can carry a record id,
     and a stored map has no business holding one. */
  for (const href of links) {
    try {
      consider(new URL(href).pathname);
    } catch {
      /* silent-ok: an unparseable href tells us nothing and there is nothing
         to report about it beyond its absence from a best-effort list. */
    }
  }
  return found;
}

/** One sentence about whether the data can be moved. */
export function describeExports(exports: ExportAffordance[]): string {
  if (exports.length === 0) {
    return "No way to export was visible on the screens that were opened. That is not the same as there being none: it may sit behind a menu, a permission, or a settings page this walk did not reach.";
  }
  const kinds = [...new Set(exports.map((e) => e.kind))];
  return `Data appears to be gettable out by ${kinds.join(" and ")}. Detected, not tested: nothing was downloaded.`;
}
