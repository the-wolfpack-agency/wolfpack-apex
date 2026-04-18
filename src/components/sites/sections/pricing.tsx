/**
 * Pricing section — grid of plan tiers (Starter / Pro / Enterprise…).
 *
 * Each tier is its own <section> with a heading, price, feature list, and
 * optional CTA. One item may set `highlighted: true` to get a ring-style
 * accent — conventional "featured" tier treatment.
 *
 * Safety:
 *   - No dangerouslySetInnerHTML. All plan name / price / feature strings
 *     flow through JSX text nodes (escaped).
 *   - Items missing `name`, `price`, or a non-empty `features` array are
 *     skipped individually — validateBrief enforces at the schema layer,
 *     but the renderer degrades gracefully in preview mode too.
 *   - CTA href is rendered verbatim; the template layer sanitizes exotic
 *     schemes at build time. We do not iframe or eval anything here.
 *
 * Price stays a string ("$29/mo", "Contact us") so non-numeric labels
 * are supported without a formatter layer.
 */

import type { BriefSection } from "@/lib/sites-schema";

export interface PricingSectionProps {
  section: BriefSection;
}

interface PricingItem {
  name: string;
  price: string;
  features: string[];
  cta?: { label: string; href: string };
  highlighted?: boolean;
}

function isValid(item: unknown): item is PricingItem {
  if (!item || typeof item !== "object") return false;
  const t = item as Partial<PricingItem>;
  return typeof t.name === "string" && t.name.length > 0 &&
    typeof t.price === "string" && t.price.length > 0 &&
    Array.isArray(t.features) &&
    t.features.length > 0 &&
    t.features.every((f) => typeof f === "string");
}

export function PricingSection({ section }: PricingSectionProps) {
  const { heading, body, items } = section;
  const valid = ((items as unknown[]) ?? []).filter(isValid) as PricingItem[];

  return (
    <section
      data-testid="pricing-section"
      data-section-type="pricing"
      className="mx-auto w-full max-w-6xl px-4 md:px-6"
    >
      {heading ? (
        <h2 className="mb-2 text-2xl font-semibold tracking-tight text-neutral-900 md:text-3xl">
          {heading}
        </h2>
      ) : null}
      {body ? (
        <p className="mb-5 text-sm leading-relaxed text-neutral-600 md:text-base">
          {body}
        </p>
      ) : null}

      {valid.length === 0 ? (
        <div
          data-testid="pricing-empty"
          className="rounded-lg border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500"
        >
          No pricing tiers yet — add plans in the editor.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {valid.map((tier, idx) => {
            const highlighted = tier.highlighted === true;
            return (
              <section
                key={idx}
                data-testid="pricing-item"
                data-highlighted={highlighted ? "true" : "false"}
                className={`flex flex-col gap-4 rounded-lg bg-white p-6 shadow-sm ${
                  highlighted
                    ? "pricing-highlighted border-2 border-amber-500 ring-2 ring-amber-200"
                    : "border border-neutral-200"
                }`}
              >
                <header className="flex flex-col gap-1">
                  <h3 className="text-lg font-semibold text-neutral-900">{tier.name}</h3>
                  <p className="text-2xl font-bold tracking-tight text-neutral-900">
                    {tier.price}
                  </p>
                </header>
                <ul className="flex flex-col gap-2 text-sm text-neutral-700">
                  {tier.features.map((feature, fi) => (
                    <li
                      key={fi}
                      data-testid="pricing-feature"
                      className="flex items-start gap-2 leading-relaxed"
                    >
                      <span aria-hidden="true" className="mt-[2px] text-amber-500">
                        ✓
                      </span>
                      <span>{feature}</span>
                    </li>
                  ))}
                </ul>
                {tier.cta?.href && tier.cta?.label ? (
                  <a
                    href={tier.cta.href}
                    data-testid="pricing-cta"
                    className={`mt-auto inline-flex items-center justify-center rounded-md px-4 py-2 text-sm font-semibold ${
                      highlighted
                        ? "bg-amber-500 text-white hover:bg-amber-600"
                        : "bg-neutral-900 text-white hover:bg-neutral-800"
                    }`}
                  >
                    {tier.cta.label}
                  </a>
                ) : null}
              </section>
            );
          })}
        </div>
      )}
    </section>
  );
}

export default PricingSection;
