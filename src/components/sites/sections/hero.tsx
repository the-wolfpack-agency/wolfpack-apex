/**
 * Hero section — big heading + body + optional CTA + optional bg image.
 *
 * Matches the visual vocabulary of wolfpack-site-template's ParallaxBg +
 * Reveal hero (see src/app/page.tsx there). We don't recreate the
 * parallax/reveal animations in the preview — the preview only needs to
 * be faithful enough that the user sees their content land. Mobile-first,
 * responsive, no raw HTML injection.
 */

import type { BriefSection } from "@/lib/sites";

export interface HeroSectionProps {
  section: BriefSection;
}

export function HeroSection({ section }: HeroSectionProps) {
  const { heading, body, cta, backgroundImage, height } = section;

  const bgStyle: React.CSSProperties = backgroundImage
    ? {
        backgroundImage: `linear-gradient(rgba(0,0,0,0.35), rgba(0,0,0,0.35)), url(${JSON.stringify(backgroundImage)})`,
        backgroundSize: "cover",
        backgroundPosition: "center",
      }
    : {};

  const minHeight = height || "70vh";

  // Nothing meaningful to show? Render a minimal placeholder so the
  // section still reserves vertical space in the preview.
  if (!heading && !body && !cta) {
    return (
      <section
        data-testid="hero-section"
        data-section-type="hero"
        className="flex items-center justify-center bg-neutral-100 p-8 text-center text-sm text-neutral-400"
        style={{ minHeight }}
      >
        Hero section
      </section>
    );
  }

  return (
    <section
      data-testid="hero-section"
      data-section-type="hero"
      className={`relative flex w-full items-center px-4 py-16 md:px-12 md:py-24 ${
        backgroundImage ? "text-white" : "text-neutral-900"
      }`}
      style={{ minHeight, ...bgStyle }}
    >
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
        {heading ? (
          <h1 className="text-3xl font-bold leading-tight tracking-tight md:text-5xl">
            {heading}
          </h1>
        ) : null}
        {body ? (
          <p className={`max-w-3xl text-base leading-relaxed md:text-lg ${
            backgroundImage ? "text-white/90" : "text-neutral-700"
          }`}>
            {body}
          </p>
        ) : null}
        {cta?.href && cta.label ? (
          <div className="mt-4">
            <a
              href={cta.href}
              data-testid="hero-cta"
              className={`inline-flex items-center rounded-md px-5 py-2.5 text-sm font-semibold transition ${
                backgroundImage
                  ? "bg-white text-neutral-900 hover:bg-neutral-100"
                  : "bg-neutral-900 text-white hover:bg-neutral-800"
              }`}
            >
              {cta.label}
            </a>
          </div>
        ) : null}
      </div>
    </section>
  );
}

export default HeroSection;
