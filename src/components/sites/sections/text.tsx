/**
 * Text section — heading + paragraph body. The most common section.
 * Renders as a card-like block mirroring the template's `.card` class.
 */

import type { BriefSection } from "@/lib/sites-schema";

export interface TextSectionProps {
  section: BriefSection;
}

export function TextSection({ section }: TextSectionProps) {
  const { heading, body } = section;

  if (!heading && !body) {
    return (
      <section
        data-testid="text-section"
        data-section-type="text"
        className="mx-auto w-full max-w-4xl px-4 py-4 text-center text-sm text-neutral-400"
      >
        Empty text section
      </section>
    );
  }

  return (
    <section
      data-testid="text-section"
      data-section-type="text"
      className="mx-auto w-full max-w-4xl px-4 md:px-6"
    >
      <div className="rounded-lg border border-neutral-200 bg-white p-6 shadow-sm md:p-8">
        {heading ? (
          <h2 className="mb-3 text-2xl font-semibold tracking-tight text-neutral-900 md:text-3xl">
            {heading}
          </h2>
        ) : null}
        {body ? (
          <p className="text-base leading-relaxed text-neutral-700 md:text-lg">
            {body}
          </p>
        ) : null}
      </div>
    </section>
  );
}

export default TextSection;
