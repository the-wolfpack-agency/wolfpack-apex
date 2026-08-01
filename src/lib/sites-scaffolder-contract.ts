/**
 * What the deploy target can actually build.
 *
 * Instinct is not the thing that renders a client's site. It authors a brief,
 * writes it to `briefs/<slug>.json` in a repo generated from
 * the-wolfpack-agency/wolfpack-site-template, and dispatches that repo's
 * workflow. The template's `scripts/scaffold-client-site.mjs` is what turns the
 * brief into pages. So there are two renderers for one brief: this repo's
 * preview, and the scaffolder's output. The preview is what an operator
 * approves; the scaffolder is what a client gets.
 *
 * THE DRIFT THIS EXISTS TO STOP BEING SILENT
 *
 * The two lists were out of step for months. This repo listed 12 types; the
 * scaffolder validated against its own hard-coded 8 and called `process.exit(1)`
 * on anything else, so a brief containing video, testimonial, pricing or faq
 * rendered correctly in the studio preview, was accepted by this repo's API,
 * and then failed the deploy outright. wolfpack-site-template PR #1 closed the
 * gap by implementing the four, so the sets match today.
 *
 * They match today. That is precisely why this file still exists: the sets
 * being equal is a fact to be re-checked on every change, not a state to be
 * assumed. `unbuildableSectionTypes()` returning empty is a MEASUREMENT.
 *
 * This file records the target's real capability so the gap is a value in the
 * code with a test on it, rather than a surprise at deploy time. It is a MIRROR
 * of another repo, which is duplication and is called out as such: the moment
 * the template can express its own capability (a committed contract file the
 * scaffolder reads), this should become a client of that instead. Until then a
 * mirror with a test beats an assumption with none.
 *
 * Keeping it up to date: the source of truth is `knownTypes` in
 * wolfpack-site-template `scripts/scaffold-client-site.mjs`.
 */
import { SUPPORTED_SECTION_TYPES, type SectionType } from "./sites-schema";

/** Section types wolfpack-site-template's scaffolder implements today. */
export const SCAFFOLDER_SECTION_TYPES: readonly SectionType[] = [
  "hero",
  "text",
  "cards",
  "callout",
  "banner",
  "stats",
  "gallery",
  "quote",
  // Added by wolfpack-site-template PR #1, which also fixed a codegen
  // injection in the same generator. The gap these four represented is closed:
  // the studio and the deploy target now build the same set.
  "video",
  "testimonial",
  "pricing",
  "faq",
] as const;

/** Where the mirrored list came from, so a reviewer can check it in one hop. */
export const SCAFFOLDER_SOURCE = {
  repo: "the-wolfpack-agency/wolfpack-site-template",
  file: "scripts/scaffold-client-site.mjs",
  symbol: "knownTypes",
} as const;

/**
 * Types the studio offers that the deploy target cannot build. Empty today,
 * because the template caught up. It is still computed rather than asserted, so
 * the next type added on one side and not the other shows up here.
 */
export function unbuildableSectionTypes(): SectionType[] {
  return SUPPORTED_SECTION_TYPES.filter((t) => !SCAFFOLDER_SECTION_TYPES.includes(t));
}

/** Would this brief's section types survive the scaffolder? */
export function canScaffold(types: readonly SectionType[]): { ok: boolean; unsupported: SectionType[] } {
  const unsupported = [...new Set(types)].filter((t) => !SCAFFOLDER_SECTION_TYPES.includes(t));
  return { ok: unsupported.length === 0, unsupported };
}
