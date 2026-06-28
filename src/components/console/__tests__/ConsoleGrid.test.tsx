/**
 * @jest-environment jsdom
 *
 * ConsoleGrid. Asserts: renders every child, wraps each in a StaggeredItem
 * (reusing the shared reveal motion — wp-stagger-item class), staggered delay
 * derives from index, empty state (no children), stagger=false renders flat
 * without the reveal class, and that it does NOT fire analytics (pure kit).
 */

import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";

const mockFetch = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: unknown[]) => mockFetch(...a),
  jsonHeaders: () => ({ "Content-Type": "application/json" }),
}));

import { ConsoleGrid } from "@/components/console";

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
});

describe("ConsoleGrid", () => {
  test("renders all children", () => {
    render(
      <ConsoleGrid>
        <div>one</div>
        <div>two</div>
        <div>three</div>
      </ConsoleGrid>,
    );
    expect(screen.getByText("one")).toBeInTheDocument();
    expect(screen.getByText("two")).toBeInTheDocument();
    expect(screen.getByText("three")).toBeInTheDocument();
    expect(screen.getByTestId("console-grid").getAttribute("data-count")).toBe(
      "3",
    );
  });

  test("wraps each child in the shared stagger reveal (wp-stagger-item)", () => {
    render(
      <ConsoleGrid>
        <div>a</div>
        <div>b</div>
      </ConsoleGrid>,
    );
    const item0 = screen.getByTestId("console-grid-item-0");
    const item1 = screen.getByTestId("console-grid-item-1");
    expect(item0.className).toContain("wp-stagger-item");
    expect(item1.className).toContain("wp-stagger-item");
    // delay derives from index * staggerMs (default 40ms)
    expect(item0.getAttribute("style")).toContain("0ms");
    expect(item1.getAttribute("style")).toContain("40ms");
  });

  test("custom staggerMs is forwarded to the items", () => {
    render(
      <ConsoleGrid staggerMs={60}>
        <div>a</div>
        <div>b</div>
      </ConsoleGrid>,
    );
    expect(
      screen.getByTestId("console-grid-item-1").getAttribute("style"),
    ).toContain("60ms");
  });

  test("stagger=false renders flat cells without the reveal class", () => {
    render(
      <ConsoleGrid stagger={false}>
        <div>a</div>
      </ConsoleGrid>,
    );
    const item = screen.getByTestId("console-grid-item-0");
    expect(item.className).not.toContain("wp-stagger-item");
    expect(screen.getByText("a")).toBeInTheDocument();
  });

  test("empty state — no children, count 0, no items", () => {
    render(<ConsoleGrid>{[]}</ConsoleGrid>);
    expect(screen.getByTestId("console-grid").getAttribute("data-count")).toBe(
      "0",
    );
    expect(screen.queryByTestId("console-grid-item-0")).not.toBeInTheDocument();
  });

  test("is pure — does NOT fire any analytics on mount", () => {
    render(
      <ConsoleGrid>
        <div>a</div>
        <div>b</div>
      </ConsoleGrid>,
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
