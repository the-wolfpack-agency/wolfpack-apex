/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import MetricsTiles from "@/app/(dashboard)/support/analytics/_components/MetricsTiles";

describe("<MetricsTiles />", () => {
  test("renders all four tiles with the values it was given", () => {
    render(
      <MetricsTiles
        tokensSaved={12_345}
        cacheHitRate={0.732}
        aiCalls={500}
        timeSavedMs={75_000}
      />,
    );

    expect(screen.getByTestId("metric-tile-tokens-saved-value").textContent).toBe(
      "12,345",
    );
    /* 0.732 -> "73.2%" with one decimal place. */
    expect(
      screen.getByTestId("metric-tile-cache-hit-rate-value").textContent,
    ).toBe("73.2%");
    expect(screen.getByTestId("metric-tile-ai-calls-value").textContent).toBe(
      "500",
    );
    /* 75 seconds -> "1m 15s" */
    expect(screen.getByTestId("metric-tile-time-saved-value").textContent).toBe(
      "1m 15s",
    );
  });
});
