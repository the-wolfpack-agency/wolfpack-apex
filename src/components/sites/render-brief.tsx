/**
 * RenderBrief — shared server-renderable view of a SiteBrief page.
 *
 * Used by the live-preview iframe on the Sites editor. Delegates each
 * section to its typed renderer. Never interpolates user content as HTML
 * (no dangerouslySetInnerHTML); JSX handles escaping on every text field.
 *
 * Defaults:
 *   - page defaults to 0; out-of-range index falls through to empty state.
 *   - brief with zero pages renders a friendly empty state rather than
 *     throwing — so a half-built draft never blanks the iframe.
 *   - Unknown section types (shouldn't happen given validateBrief, but
 *     defensive) render nothing.
 */

import type { CSSProperties } from "react";
import type { SiteBrief, BriefSection, SectionType } from "@/lib/sites-schema";
import { normalizeTheme, themeToCssVars } from "@/lib/site-theme";
import {
  resolveThemeTokens,
  themeTokensToCssVarObject,
} from "@/lib/site-theme-tokens";
import { HeroSection } from "./sections/hero";
import { TextSection } from "./sections/text";
import { CardsSection } from "./sections/cards";
import { GallerySection } from "./sections/gallery";
import { QuoteSection } from "./sections/quote";
import { StatsSection } from "./sections/stats";
import { CalloutSection } from "./sections/callout";
import { BannerSection } from "./sections/banner";
import { VideoSection } from "./sections/video";
import { TestimonialSection } from "./sections/testimonial";
import { PricingSection } from "./sections/pricing";
import { FaqSection } from "./sections/faq";

export interface RenderBriefProps {
  brief: SiteBrief;
  /** Zero-based page index. Defaults to 0. */
  page?: number;
}

/**
 * Dispatch a section by its discriminant. Returns null for unknown types
 * so the page doesn't explode on a malformed brief that sneaks past
 * validation.
 */
export function RenderSection({ section, index }: { section: BriefSection; index: number }) {
  const key = `${section.type}-${index}`;
  const type: SectionType = section.type;
  switch (type) {
    case "hero":
      return <HeroSection key={key} section={section} />;
    case "text":
      return <TextSection key={key} section={section} />;
    case "cards":
      return <CardsSection key={key} section={section} />;
    case "gallery":
      return <GallerySection key={key} section={section} />;
    case "quote":
      return <QuoteSection key={key} section={section} />;
    case "stats":
      return <StatsSection key={key} section={section} />;
    case "callout":
      return <CalloutSection key={key} section={section} />;
    case "banner":
      return <BannerSection key={key} section={section} />;
    case "video":
      return <VideoSection key={key} section={section} />;
    case "testimonial":
      return <TestimonialSection key={key} section={section} />;
    case "pricing":
      return <PricingSection key={key} section={section} />;
    case "faq":
      return <FaqSection key={key} section={section} />;
    default:
      return null;
  }
}

export function RenderBrief({ brief, page = 0 }: RenderBriefProps) {
  const pages = brief?.pages ?? [];
  if (pages.length === 0) {
    return (
      <div
        data-testid="render-brief-empty"
        className="flex min-h-[60vh] flex-col items-center justify-center gap-2 p-8 text-center"
      >
        <h2 className="text-xl font-semibold text-neutral-800">Nothing to preview yet</h2>
        <p className="max-w-md text-sm text-neutral-500">
          This brief has no pages. Add a page in the editor to see a live preview here.
        </p>
      </div>
    );
  }

  const selected = pages[page] ?? pages[0];
  const sections = selected.sections ?? [];

  // Brand theme → CSS custom properties. The section components all
  // reference `var(--wp-site-*)` with baked-in fallbacks, so omitting a
  // variable here cleanly degrades to the neutral default. We emit the
  // variables both as a <style>:root{} rule (for selectors inside
  // sections that look up :root) AND as an inline style on the <main>
  // (for sections that consume the variable via React's style prop). If
  // theme is undefined, both paths collapse to no-ops.
  //
  // Path C Phase 1 · Stream P4: we ALSO emit the design-token scales
  // (spacing / radius / type / motion) from `resolveThemeTokens` so
  // section renderers can consume `var(--wp-space-md)` etc. without
  // needing to fall back. The two emitters are merged — legacy color
  // names stay on `--wp-site-*` so existing CSS selectors don't break.
  const normalized = normalizeTheme(selected ? brief.theme : undefined);
  const legacyVars = themeToCssVars(normalized);
  const resolved = resolveThemeTokens(
    selected && brief.theme && typeof brief.theme === "object"
      ? (normalized as Parameters<typeof resolveThemeTokens>[0])
      : undefined,
  );
  const tokenVars = themeTokensToCssVarObject(resolved);
  // Legacy vars win over token vars for the 5 color slots — if a client
  // set a color but left spacing at defaults, we still emit both; if
  // spacing has defaults only, the token vars carry them.
  const cssVars: Record<string, string> = { ...tokenVars, ...legacyVars };
  const rootVarCss = Object.entries(cssVars)
    .map(([k, v]) => `${k}: ${v};`)
    .join(" ");
  const styleBlock = rootVarCss
    ? `[data-testid="render-brief"] { ${rootVarCss} }`
    : "";

  return (
    <main
      data-testid="render-brief"
      data-page-index={String(page)}
      data-page-route={selected.route}
      className="flex min-h-screen flex-col bg-white text-neutral-900"
      style={cssVars as CSSProperties}
    >
      {styleBlock ? (
        <style data-testid="render-brief-theme-style">{styleBlock}</style>
      ) : null}
      {selected.title ? (
        <header className="sr-only">
          <h1>{selected.title}</h1>
        </header>
      ) : null}

      {sections.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-8 text-sm text-neutral-500">
          This page has no sections yet.
        </div>
      ) : (
        <div
          data-testid="render-brief-sections"
          // Path C · P4: between-section spacing comes from the 2xl spacing
          // token; designers widen/tighten rhythm per brand.
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "var(--wp-space-2xl, 3rem)",
            paddingTop: "var(--wp-space-lg, 2rem)",
            paddingBottom: "var(--wp-space-lg, 2rem)",
          }}
        >
          {sections.map((section, idx) => (
            <RenderSection key={`${section.type}-${idx}`} section={section} index={idx} />
          ))}
        </div>
      )}
    </main>
  );
}

export default RenderBrief;
