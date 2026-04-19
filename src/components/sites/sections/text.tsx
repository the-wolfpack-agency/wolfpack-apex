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
      <div
        // Path C · P4: card border-radius + inner padding from tokens.
        style={{
          borderRadius: "var(--wp-radius-lg, 0.5rem)",
          padding: "var(--wp-space-lg, 1.5rem)",
        }}
        className="border border-neutral-200 bg-white shadow-sm md:p-8"
      >
        {heading ? (
          <h2
            style={{
              fontSize: "var(--wp-type-3xl-size, 1.5rem)",
              lineHeight: "var(--wp-type-3xl-line, 2rem)",
              fontWeight: "var(--wp-font-weight-bold, 600)",
              marginBottom: "var(--wp-space-sm, 0.75rem)",
            }}
            className="tracking-tight text-neutral-900"
          >
            {heading}
          </h2>
        ) : null}
        {body ? (
          <p
            style={{
              fontSize: "var(--wp-type-base-size, 1rem)",
              lineHeight: "var(--wp-type-base-line, 1.5)",
            }}
            className="text-neutral-700"
          >
            {body}
          </p>
        ) : null}
      </div>
    </section>
  );
}

export default TextSection;
