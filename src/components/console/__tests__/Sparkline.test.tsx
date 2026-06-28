/**
 * @jest-environment jsdom
 *
 * Sparkline — pure inline SVG. Asserts: renders an <svg>, point count from
 * data, handles 0 / 1 / n points, optional area fill + last dot, custom
 * accent, and that bad values are filtered out.
 */

import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { Sparkline } from "@/components/console";

function lineCoords(): string[] {
  const line = screen.getByTestId("sparkline-line");
  return (line.getAttribute("points") || "").trim().split(/\s+/).filter(Boolean);
}

describe("Sparkline", () => {
  test("renders an <svg> with a polyline for n points", () => {
    render(<Sparkline data={[1, 2, 3, 4, 5]} />);
    const svg = screen.getByTestId("sparkline");
    expect(svg.tagName.toLowerCase()).toBe("svg");
    expect(svg.getAttribute("data-points")).toBe("5");
    expect(lineCoords()).toHaveLength(5);
  });

  test("0 points → empty svg, no line/dot (empty state)", () => {
    render(<Sparkline data={[]} />);
    const svg = screen.getByTestId("sparkline");
    expect(svg).toBeInTheDocument();
    expect(svg.getAttribute("data-points")).toBe("0");
    expect(screen.queryByTestId("sparkline-line")).not.toBeInTheDocument();
    expect(screen.queryByTestId("sparkline-dot")).not.toBeInTheDocument();
  });

  test("1 point → a single coordinate + a dot (flat baseline)", () => {
    render(<Sparkline data={[42]} />);
    expect(screen.getByTestId("sparkline").getAttribute("data-points")).toBe(
      "1",
    );
    expect(lineCoords()).toHaveLength(1);
    expect(screen.getByTestId("sparkline-dot")).toBeInTheDocument();
  });

  test("all-equal values render without NaN (flat line, span 0)", () => {
    render(<Sparkline data={[7, 7, 7]} />);
    const pts = lineCoords();
    expect(pts).toHaveLength(3);
    expect(pts.join(" ")).not.toContain("NaN");
  });

  test("area fill renders a polygon when area is on", () => {
    render(<Sparkline data={[1, 5, 2, 8]} area />);
    expect(screen.getByTestId("sparkline-area")).toBeInTheDocument();
  });

  test("no area polygon by default", () => {
    render(<Sparkline data={[1, 5, 2, 8]} />);
    expect(screen.queryByTestId("sparkline-area")).not.toBeInTheDocument();
  });

  test("showLastDot=false hides the dot", () => {
    render(<Sparkline data={[1, 2, 3]} showLastDot={false} />);
    expect(screen.queryByTestId("sparkline-dot")).not.toBeInTheDocument();
  });

  test("custom accent colour is applied to the line stroke", () => {
    render(<Sparkline data={[1, 2, 3]} accent="var(--wp-gold)" />);
    expect(
      screen.getByTestId("sparkline-line").getAttribute("stroke"),
    ).toBe("var(--wp-gold)");
  });

  test("non-finite values are filtered out of the series", () => {
    render(<Sparkline data={[1, NaN, 3, Infinity, 5]} />);
    expect(screen.getByTestId("sparkline").getAttribute("data-points")).toBe(
      "3",
    );
    expect(lineCoords()).toHaveLength(3);
  });

  test("respects custom width/height on the svg viewport", () => {
    render(<Sparkline data={[1, 2]} width={120} height={40} />);
    const svg = screen.getByTestId("sparkline");
    expect(svg.getAttribute("width")).toBe("120");
    expect(svg.getAttribute("height")).toBe("40");
  });
});
