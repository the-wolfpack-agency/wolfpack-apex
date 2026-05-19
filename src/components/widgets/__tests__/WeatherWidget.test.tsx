/**
 * @jest-environment jsdom
 *
 * WeatherWidget — renders the temperature card, fires widget_rendered
 * analytics on mount, and handles the empty-state path.
 */

import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";

const mockFetch = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: unknown[]) => mockFetch(...a),
  jsonHeaders: () => ({ "Content-Type": "application/json" }),
}));

import { WeatherWidget } from "@/components/widgets/WeatherWidget";
import type { WeatherWidgetSpec } from "@/lib/assistant/widgets/types";

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
});

const baseSpec: WeatherWidgetSpec = {
  kind: "weather",
  location: "Boston, Massachusetts, US",
  temperatureC: 21,
  temperatureF: 69.8,
  condition: "Partly cloudy",
  highC: 24,
  lowC: 14,
  humidity: 65,
  windMph: 8,
};

describe("WeatherWidget", () => {
  test("renders temperature, location, condition", () => {
    render(<WeatherWidget spec={baseSpec} />);
    expect(screen.getByTestId("weather-widget")).toBeInTheDocument();
    expect(screen.getByText(/Boston/)).toBeInTheDocument();
    expect(screen.getByTestId("weather-temperature").textContent).toMatch(/70°F/);
    expect(screen.getByTestId("weather-condition").textContent).toBe("Partly cloudy");
  });

  test("renders high/low/humidity/wind cells", () => {
    render(<WeatherWidget spec={baseSpec} />);
    expect(screen.getByTestId("weather-highlow").textContent).toMatch(/High 75/);
    expect(screen.getByTestId("weather-highlow").textContent).toMatch(/Low 57/);
    expect(screen.getByTestId("weather-humidity").textContent).toMatch(/65%/);
    expect(screen.getByTestId("weather-wind").textContent).toMatch(/8 mph/);
  });

  test("fires widget_rendered analytics on mount", () => {
    render(<WeatherWidget spec={baseSpec} />);
    const body = mockFetch.mock.calls[0]?.[1]?.body;
    expect(body).toContain("assistant.widget_rendered");
    expect(body).toContain("weather");
  });

  test("workflowId is forwarded into analytics payload", () => {
    render(<WeatherWidget spec={baseSpec} workflowId="wf-xyz" />);
    const body = mockFetch.mock.calls[0]?.[1]?.body;
    expect(body).toContain('"workflow_id":"wf-xyz"');
  });

  test("empty-state-ish (zero humidity / negative temps) still renders without crash", () => {
    render(
      <WeatherWidget
        spec={{
          ...baseSpec,
          temperatureC: -10,
          temperatureF: 14,
          highC: -5,
          lowC: -15,
          humidity: 0,
          windMph: 0,
          condition: "Snowy",
        }}
      />,
    );
    expect(screen.getByTestId("weather-temperature").textContent).toMatch(/14°F/);
    expect(screen.getByTestId("weather-condition").textContent).toBe("Snowy");
  });
});
