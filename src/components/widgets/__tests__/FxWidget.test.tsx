/**
 * @jest-environment jsdom
 *
 * FxWidget — renders a table of FX rates, fires widget_rendered
 * analytics on mount, handles empty-state.
 */

import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";

const mockFetch = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: unknown[]) => mockFetch(...a),
  jsonHeaders: () => ({ "Content-Type": "application/json" }),
}));

import { FxWidget } from "@/components/widgets/FxWidget";
import type { FxWidgetSpec } from "@/lib/assistant/widgets/types";

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
});

const baseSpec: FxWidgetSpec = {
  kind: "fx",
  base: "USD",
  asOf: "2026-05-19",
  rates: [
    { code: "EUR", value: 0.92 },
    { code: "GBP", value: 0.78 },
    { code: "JPY", value: 155.4 },
    { code: "CAD", value: 1.36 },
    { code: "AUD", value: 1.5 },
  ],
};

describe("FxWidget", () => {
  test("renders base, as-of date, and a row per rate", () => {
    render(<FxWidget spec={baseSpec} />);
    expect(screen.getByTestId("fx-widget")).toBeInTheDocument();
    expect(screen.getByText(/base USD/)).toBeInTheDocument();
    expect(screen.getByText(/2026-05-19/)).toBeInTheDocument();
    expect(screen.getByTestId("fx-row-EUR")).toBeInTheDocument();
    expect(screen.getByTestId("fx-row-JPY")).toBeInTheDocument();
  });

  test("renders rates with 4 decimal precision", () => {
    render(<FxWidget spec={baseSpec} />);
    expect(screen.getByTestId("fx-row-EUR").textContent).toMatch(/0\.9200/);
    expect(screen.getByTestId("fx-row-JPY").textContent).toMatch(/155\.4000/);
  });

  test("fires widget_rendered analytics on mount", () => {
    render(<FxWidget spec={baseSpec} />);
    const body = mockFetch.mock.calls.find((c) =>
      String(c[1]?.body || "").includes("widget_rendered"),
    )?.[1]?.body;
    expect(String(body)).toContain('"widget_kind":"fx"');
    expect(String(body)).toContain('"base":"USD"');
    expect(String(body)).toContain('"rate_count":5');
  });

  test("workflowId is forwarded into analytics payload", () => {
    render(<FxWidget spec={baseSpec} workflowId="wf-fx" />);
    const body = mockFetch.mock.calls[0]?.[1]?.body;
    expect(String(body)).toContain('"workflow_id":"wf-fx"');
  });

  test("empty-state when rates is []", () => {
    render(<FxWidget spec={{ ...baseSpec, rates: [] }} />);
    expect(screen.getByTestId("fx-empty")).toBeInTheDocument();
    expect(screen.getByText(/No FX rates/)).toBeInTheDocument();
  });
});
