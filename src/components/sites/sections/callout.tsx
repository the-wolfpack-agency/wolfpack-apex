/**
 * Callout section — aside/note card with left-border accent. Mirrors the
 * template's `aside.card` with `borderLeft: 3px solid accent` style.
 * Heading + body are both optional; CTA is rendered inline.
 */

import type { BriefSection } from "@/lib/sites-schema";

export interface CalloutSectionProps {
  section: BriefSection;
}

export function CalloutSection({ section }: CalloutSectionProps) {
  const { heading, body, cta } = section;

  if (!heading && !body && !cta) {
    return (
      <section
        data-testid="callout-section"
        data-section-type="callout"
        className="mx-auto w-full max-w-4xl px-4 py-4 text-center text-sm text-neutral-400"
      >
        Empty callout
      </section>
    );
  }

  return (
    <section
      data-testid="callout-section"
      data-section-type="callout"
      className="mx-auto w-full max-w-4xl px-4 md:px-6"
    >
      <aside className="flex flex-col gap-3 rounded-lg border-l-4 border-amber-500 bg-amber-50 p-5 md:p-6">
        {heading ? (
          <h3 className="text-lg font-semibold text-neutral-900">{heading}</h3>
        ) : null}
        {body ? (
          <p className="text-sm leading-relaxed text-neutral-700 md:text-base">
            {body}
          </p>
        ) : null}
        {cta?.href && cta.label ? (
          <div>
            <a
              href={cta.href}
              data-testid="callout-cta"
              className="inline-flex items-center rounded-md bg-neutral-900 px-4 py-2 text-sm font-semibold text-white hover:bg-neutral-800"
            >
              {cta.label}
            </a>
          </div>
        ) : null}
      </aside>
    </section>
  );
}

export default CalloutSection;
