/**
 * Testimonial section — array of pull quotes with author attribution.
 *
 * Semantic HTML: each item is a <figure> with <blockquote> + <figcaption>
 * containing <cite> for the author. Mirrors the conventional pattern
 * called out in HTML Living Standard § figure/blockquote; mostly it
 * means screen readers and RSS-style parsers see structured quote data
 * rather than a pile of <div>s.
 *
 * Safety:
 *   - No dangerouslySetInnerHTML anywhere. All fields (quote, author
 *     name / title) flow through JSX text nodes so React escapes them.
 *   - authorPhotoUrl is only rendered when it starts with `https://` —
 *     validateBrief enforces this at the schema layer; we re-check here
 *     because unknown briefs could bypass validation in preview mode.
 *   - Items with missing required fields (quote OR authorName) are
 *     filtered out. A crashed item should never blank the whole page.
 *
 * Empty state: zero valid items → dashed placeholder (matches the
 * cards/stats pattern) so the editor always has something to look at.
 */

import type { BriefSection } from "@/lib/sites-schema";

export interface TestimonialSectionProps {
  section: BriefSection;
}

interface TestimonialItem {
  quote: string;
  authorName: string;
  authorTitle?: string;
  authorPhotoUrl?: string;
}

function isValid(item: unknown): item is TestimonialItem {
  if (!item || typeof item !== "object") return false;
  const t = item as Partial<TestimonialItem>;
  return typeof t.quote === "string" && t.quote.length > 0 &&
    typeof t.authorName === "string" && t.authorName.length > 0;
}

export function TestimonialSection({ section }: TestimonialSectionProps) {
  const { heading, items } = section;
  const valid = ((items as unknown[]) ?? []).filter(isValid) as TestimonialItem[];

  return (
    <section
      data-testid="testimonial-section"
      data-section-type="testimonial"
      className="mx-auto w-full max-w-6xl px-4 md:px-6"
    >
      {heading ? (
        <h2 className="mb-5 text-2xl font-semibold tracking-tight text-neutral-900 md:text-3xl">
          {heading}
        </h2>
      ) : null}

      {valid.length === 0 ? (
        <div
          data-testid="testimonial-empty"
          className="rounded-lg border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500"
        >
          No testimonials yet — add quotes in the editor.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {valid.map((item, idx) => {
            const safePhoto =
              typeof item.authorPhotoUrl === "string" && item.authorPhotoUrl.startsWith("https://")
                ? item.authorPhotoUrl
                : null;
            return (
              <figure
                key={idx}
                data-testid="testimonial-item"
                className="flex flex-col gap-4 rounded-lg border border-neutral-200 bg-white p-5 shadow-sm"
              >
                <blockquote className="text-base italic leading-relaxed text-neutral-700">
                  {item.quote}
                </blockquote>
                <figcaption className="flex items-center gap-3">
                  {safePhoto ? (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img
                      src={safePhoto}
                      alt=""
                      data-testid="testimonial-photo"
                      className="h-10 w-10 rounded-full object-cover"
                      loading="lazy"
                    />
                  ) : null}
                  <div className="flex flex-col">
                    <cite className="text-sm font-semibold not-italic text-neutral-900">
                      {item.authorName}
                    </cite>
                    {item.authorTitle ? (
                      <span className="text-xs text-neutral-500">{item.authorTitle}</span>
                    ) : null}
                  </div>
                </figcaption>
              </figure>
            );
          })}
        </div>
      )}
    </section>
  );
}

export default TestimonialSection;
