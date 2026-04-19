/**
 * Cards section — grid of titled cards with optional accent / badge.
 * Mirrors the template's cards block (see template `page.tsx`: auto-fit
 * minmax(220px, 1fr) grid, accent via left border).
 */

import type { BriefSection } from "@/lib/sites-schema";

export interface CardsSectionProps {
  section: BriefSection;
}

export function CardsSection({ section }: CardsSectionProps) {
  const { heading, items } = section;
  const cards = items ?? [];

  return (
    <section
      data-testid="cards-section"
      data-section-type="cards"
      className="mx-auto w-full max-w-6xl px-4 md:px-6"
    >
      {heading ? (
        <h2 className="mb-5 text-2xl font-semibold tracking-tight text-neutral-900 md:text-3xl">
          {heading}
        </h2>
      ) : null}

      {cards.length === 0 ? (
        <div
          data-testid="cards-empty"
          className="rounded-lg border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500"
        >
          No cards yet — add items in the editor.
        </div>
      ) : (
        <div
          data-testid="cards-grid"
          className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
        >
          {cards.map((card, idx) => {
            const accent = !!card.accent;
            return (
              <div
                key={idx}
                data-testid="cards-item"
                // Path C · P4: card border-radius + padding from tokens.
                style={{
                  borderRadius: "var(--wp-radius-md, 0.5rem)",
                  padding: "var(--wp-space-lg, 1.25rem)",
                }}
                className={`flex flex-col gap-2 border bg-white shadow-sm ${
                  accent
                    ? "border-l-4 border-l-amber-500 border-y-neutral-200 border-r-neutral-200"
                    : "border-neutral-200"
                }`}
              >
                {card.badge ? (
                  <div className="text-[0.7rem] font-semibold uppercase tracking-widest text-amber-600">
                    {card.badge}
                  </div>
                ) : null}
                {card.title ? (
                  <h3 className="text-lg font-semibold text-neutral-900">{card.title}</h3>
                ) : null}
                {card.body ? (
                  <p className="text-sm leading-relaxed text-neutral-600">{card.body}</p>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

export default CardsSection;
