/**
 * FAQ section — collapsible question/answer list.
 *
 * Uses native <details> + <summary> so the component is fully functional
 * without client JS — the preview iframe renders it statically, the
 * deployed site gets collapse/expand without shipping any framework JS
 * for it. That also makes it screen-reader friendly by default.
 *
 * Safety:
 *   - No dangerouslySetInnerHTML. Question/answer are rendered as plain
 *     text; React escapes into text nodes.
 *   - Items missing either question or answer are skipped individually
 *     rather than crashing the page (validateBrief catches this upstream
 *     for the deploy path; renderer still degrades for preview).
 */

import type { BriefSection } from "@/lib/sites-schema";

export interface FaqSectionProps {
  section: BriefSection;
}

interface FaqItem {
  question: string;
  answer: string;
}

function isValid(item: unknown): item is FaqItem {
  if (!item || typeof item !== "object") return false;
  const t = item as Partial<FaqItem>;
  return typeof t.question === "string" && t.question.length > 0 &&
    typeof t.answer === "string" && t.answer.length > 0;
}

export function FaqSection({ section }: FaqSectionProps) {
  const { heading, items } = section;
  const valid = ((items as unknown[]) ?? []).filter(isValid) as FaqItem[];

  return (
    <section
      data-testid="faq-section"
      data-section-type="faq"
      className="mx-auto w-full max-w-4xl px-4 md:px-6"
    >
      {heading ? (
        <h2 className="mb-5 text-2xl font-semibold tracking-tight text-neutral-900 md:text-3xl">
          {heading}
        </h2>
      ) : null}

      {valid.length === 0 ? (
        <div
          data-testid="faq-empty"
          className="rounded-lg border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500"
        >
          No FAQs yet — add questions in the editor.
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {valid.map((item, idx) => (
            <li key={idx} data-testid="faq-item" className="list-none">
              <details className="group rounded-lg border border-neutral-200 bg-white p-4 shadow-sm open:border-amber-300">
                <summary
                  data-testid="faq-question"
                  className="cursor-pointer select-none text-base font-semibold text-neutral-900 marker:text-amber-500"
                >
                  {item.question}
                </summary>
                <p
                  data-testid="faq-answer"
                  className="mt-3 text-sm leading-relaxed text-neutral-600 md:text-base"
                >
                  {item.answer}
                </p>
              </details>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default FaqSection;
