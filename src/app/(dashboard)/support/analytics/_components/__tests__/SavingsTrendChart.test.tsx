/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import SavingsTrendChart, {
  type DailyTrendPoint,
} from "@/app/(dashboard)/support/analytics/_components/SavingsTrendChart";

describe("<SavingsTrendChart />", () => {
  test("renders the empty placeholder when daily_trend is empty", () => {
    render(<SavingsTrendChart data={[]} />);
    expect(screen.getByTestId("savings-trend-chart-empty")).toBeInTheDocument();
    /* No SVG should mount when there's nothing to chart. */
    expect(screen.queryByTestId("savings-trend-chart-svg")).toBeNull();
  });

  test("renders one data point per day for both series", () => {
    const data: DailyTrendPoint[] = [
      { date: "2026-04-20", tokens_saved: 100, ai_calls: 10, cache_hits: 6 },
      { date: "2026-04-21", tokens_saved: 220, ai_calls: 12, cache_hits: 9 },
      { date: "2026-04-22", tokens_saved: 540, ai_calls: 30, cache_hits: 22 },
      { date: "2026-04-23", tokens_saved: 80, ai_calls: 5, cache_hits: 3 },
    ];
    render(<SavingsTrendChart data={data} />);
    expect(screen.getByTestId("savings-trend-chart-svg")).toBeInTheDocument();
    /* One circle per day for tokens, one circle per day for hits. */
    for (let i = 0; i < data.length; i++) {
      expect(screen.getByTestId(`trend-point-tokens-${i}`)).toBeInTheDocument();
      expect(screen.getByTestId(`trend-point-hits-${i}`)).toBeInTheDocument();
    }
  });
});
