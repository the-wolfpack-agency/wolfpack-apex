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

import type { SiteBrief, BriefSection, SectionType } from "@/lib/sites-schema";
import { HeroSection } from "./sections/hero";
import { TextSection } from "./sections/text";
import { CardsSection } from "./sections/cards";
import { GallerySection } from "./sections/gallery";
import { QuoteSection } from "./sections/quote";
import { StatsSection } from "./sections/stats";
import { CalloutSection } from "./sections/callout";
import { BannerSection } from "./sections/banner";
import { VideoSection } from "./sections/video";

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

  return (
    <main
      data-testid="render-brief"
      data-page-index={String(page)}
      data-page-route={selected.route}
      className="flex min-h-screen flex-col bg-white text-neutral-900"
    >
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
        <div className="flex flex-col gap-8 md:gap-12">
          {sections.map((section, idx) => (
            <RenderSection key={`${section.type}-${idx}`} section={section} index={idx} />
          ))}
        </div>
      )}
    </main>
  );
}

export default RenderBrief;
