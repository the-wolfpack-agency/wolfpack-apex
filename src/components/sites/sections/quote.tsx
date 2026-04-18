/**
 * Quote section — pull quote with optional attribution. Body carries the
 * quote text; attribution renders as a footer line. Left border accent
 * matches template `blockquote.card` styling.
 */

import type { BriefSection } from "@/lib/sites-schema";

export interface QuoteSectionProps {
  section: BriefSection;
}

export function QuoteSection({ section }: QuoteSectionProps) {
  const { body, attribution } = section;

  if (!body && !attribution) {
    return (
      <section
        data-testid="quote-section"
        data-section-type="quote"
        className="mx-auto w-full max-w-4xl px-4 py-4 text-center text-sm text-neutral-400"
      >
        Empty quote
      </section>
    );
  }

  return (
    <section
      data-testid="quote-section"
      data-section-type="quote"
      className="mx-auto w-full max-w-4xl px-4 md:px-6"
    >
      <blockquote className="rounded-lg border-l-4 border-amber-500 bg-neutral-50 px-6 py-5 md:px-8 md:py-6">
        {body ? (
          <p className="text-lg italic leading-relaxed text-neutral-800 md:text-xl">
            {body}
          </p>
        ) : null}
        {attribution ? (
          <footer className="mt-3 text-sm not-italic text-neutral-500">
            — {attribution}
          </footer>
        ) : null}
      </blockquote>
    </section>
  );
}

export default QuoteSection;
