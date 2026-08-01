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
 * `SUPPORTED_SECTION_TYPES` in sites-schema.ts lists 12 types. The scaffolder
 * validates against its own hard-coded list of 8 and calls `process.exit(1)` on
 * anything else. So a brief containing video, testimonial, pricing or faq
 * renders correctly in the studio preview, is accepted by this repo's API, and
 * then fails the deploy outright. The comment at the top of sites.ts claims the
 * two schemas "mirror one-to-one so any brief stored here is guaranteed to
 * scaffold there". That has not been true since those four types were added
 * here without being added there.
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
] as const;

/** Where the mirrored list came from, so a reviewer can check it in one hop. */
export const SCAFFOLDER_SOURCE = {
  repo: "the-wolfpack-agency/wolfpack-site-template",
  file: "scripts/scaffold-client-site.mjs",
  symbol: "knownTypes",
} as const;

/**
 * Types the studio offers that the deploy target cannot build. Non-empty today,
 * and that is the point: an empty array would be a claim, and this is a
 * measurement.
 */
export function unbuildableSectionTypes(): SectionType[] {
  return SUPPORTED_SECTION_TYPES.filter((t) => !SCAFFOLDER_SECTION_TYPES.includes(t));
}

/** Would this brief's section types survive the scaffolder? */
export function canScaffold(types: readonly SectionType[]): { ok: boolean; unsupported: SectionType[] } {
  const unsupported = [...new Set(types)].filter((t) => !SCAFFOLDER_SECTION_TYPES.includes(t));
  return { ok: unsupported.length === 0, unsupported };
}
