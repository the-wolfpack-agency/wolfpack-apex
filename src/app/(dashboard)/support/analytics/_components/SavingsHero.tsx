"use client";

/**
 * SavingsHero — top-of-page hero metric for the AI savings analytics
 * dashboard. Renders a single big-dollar figure in gold with a one-line
 * subtitle that reads naturally: "across N AI calls, M served from cache".
 *
 * The component is purely presentational. The page is responsible for
 * window selection, fetching, and shaping numbers into props. Keeping the
 * hero dumb makes it trivial to unit test the formatter and the subtitle
 * pluralization in isolation.
 */

const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

const NUM = new Intl.NumberFormat("en-US");

export interface SavingsHeroProps {
  costSavedUsd: number;
  aiCalls: number;
  cacheHits: number;
}

/** Plural-aware "call" / "calls" / "hit" / "hits" — keeps the subtitle
 *  natural without pulling in i18n machinery. */
function plural(n: number, singular: string, pluralForm: string): string {
  return n === 1 ? singular : pluralForm;
}

export default function SavingsHero({
  costSavedUsd,
  aiCalls,
  cacheHits,
}: SavingsHeroProps) {
  const formatted = USD.format(Math.max(0, costSavedUsd || 0));
  return (
    <section
      data-testid="savings-hero"
      aria-label="AI savings hero metric"
      style={{
        background:
          "linear-gradient(180deg, rgba(241,194,51,0.10) 0%, rgba(241,194,51,0.02) 100%)",
        border: "1px solid rgba(241,194,51,0.35)",
        borderRadius: 10,
        padding: "1.4rem 1.5rem",
        marginBottom: "1.4rem",
      }}
    >
      <div
        data-testid="savings-hero-amount"
        style={{
          fontSize: "clamp(2rem, 6vw, 2.8rem)",
          fontWeight: 700,
          color: "var(--wp-gold)",
          lineHeight: 1.05,
          letterSpacing: "-0.01em",
        }}
      >
        {formatted} saved this period
      </div>
      <div
        data-testid="savings-hero-subtitle"
        style={{
          marginTop: "0.45rem",
          fontSize: "0.95rem",
          color: "var(--wp-text-dim)",
        }}
      >
        across {NUM.format(aiCalls)} AI {plural(aiCalls, "call", "calls")},{" "}
        {NUM.format(cacheHits)} served from cache
      </div>
    </section>
  );
}
