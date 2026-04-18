/**
 * Banner section — full-width colored bar with a big headline + tagline.
 * Mirrors the template's banner section (dark bg, centered text, 3rem
 * heading). Used as a visual divider between other sections.
 */

import type { BriefSection } from "@/lib/sites";

export interface BannerSectionProps {
  section: BriefSection;
}

export function BannerSection({ section }: BannerSectionProps) {
  const { heading, body, cta } = section;

  if (!heading && !body && !cta) {
    return (
      <section
        data-testid="banner-section"
        data-section-type="banner"
        className="w-full bg-neutral-100 py-8 text-center text-sm text-neutral-400"
      >
        Banner section
      </section>
    );
  }

  return (
    <section
      data-testid="banner-section"
      data-section-type="banner"
      className="w-full bg-neutral-900 px-6 py-12 text-center text-white md:py-16"
    >
      <div className="mx-auto flex w-full max-w-4xl flex-col items-center gap-3">
        {heading ? (
          <h2 className="text-3xl font-bold uppercase tracking-widest md:text-5xl">
            {heading}
          </h2>
        ) : null}
        {body ? (
          <p className="text-base text-white/80 md:text-lg">{body}</p>
        ) : null}
        {cta?.href && cta.label ? (
          <div className="mt-3">
            <a
              href={cta.href}
              data-testid="banner-cta"
              className="inline-flex items-center rounded-md bg-white px-5 py-2.5 text-sm font-semibold text-neutral-900 hover:bg-neutral-100"
            >
              {cta.label}
            </a>
          </div>
        ) : null}
      </div>
    </section>
  );
}

export default BannerSection;
