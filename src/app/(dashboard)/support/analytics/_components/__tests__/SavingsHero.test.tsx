/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import SavingsHero from "@/app/(dashboard)/support/analytics/_components/SavingsHero";

describe("<SavingsHero />", () => {
  test("renders the cost saved as USD currency in the hero amount", () => {
    render(
      <SavingsHero costSavedUsd={1234.5} aiCalls={42} cacheHits={31} />,
    );
    const amount = screen.getByTestId("savings-hero-amount");
    expect(amount).toBeInTheDocument();
    /* en-US currency formatting always emits the "$" prefix and a
       thousands separator. We assert both so a future locale flip is
       caught at the unit level rather than in the deployed UI. */
    expect(amount.textContent).toMatch(/\$1,234\.50/);
    expect(amount.textContent).toMatch(/saved this period/);
  });

  test("subtitle reports both call count and cache hit count with thousands separators", () => {
    render(
      <SavingsHero
        costSavedUsd={0}
        aiCalls={1234}
        cacheHits={1000}
      />,
    );
    const subtitle = screen.getByTestId("savings-hero-subtitle");
    expect(subtitle).toBeInTheDocument();
    expect(subtitle.textContent).toMatch(/1,234 AI calls/);
    expect(subtitle.textContent).toMatch(/1,000 served from cache/);
  });
});
