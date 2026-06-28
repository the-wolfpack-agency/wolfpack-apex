/**
 * @jest-environment jsdom
 *
 * GlassPanel — frosted container. Asserts: renders children, the optional
 * header slots (title/subtitle/actions), glow variants map to the right
 * utility class + data attr, no-header path omits the header, and the glass
 * base class is always present.
 */

import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { GlassPanel } from "@/components/console";

describe("GlassPanel", () => {
  test("renders children inside the glass surface", () => {
    render(
      <GlassPanel>
        <p>panel body</p>
      </GlassPanel>,
    );
    const panel = screen.getByTestId("glass-panel");
    expect(panel).toBeInTheDocument();
    expect(panel.className).toContain("wp-glass");
    expect(screen.getByText("panel body")).toBeInTheDocument();
  });

  test("renders title, subtitle and actions when provided", () => {
    render(
      <GlassPanel
        title="Scans"
        subtitle="last 24h"
        actions={<button>Run</button>}
      >
        body
      </GlassPanel>,
    );
    expect(screen.getByText("Scans")).toBeInTheDocument();
    expect(screen.getByText("last 24h")).toBeInTheDocument();
    expect(screen.getByTestId("glass-panel-header")).toBeInTheDocument();
    expect(screen.getByTestId("glass-panel-actions")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run" })).toBeInTheDocument();
  });

  test("no header rendered when no title/subtitle/actions (empty header state)", () => {
    render(<GlassPanel>only body</GlassPanel>);
    expect(screen.queryByTestId("glass-panel-header")).not.toBeInTheDocument();
  });

  test("glow='gold' applies the gold glow class + data attr", () => {
    render(<GlassPanel glow="gold">x</GlassPanel>);
    const panel = screen.getByTestId("glass-panel");
    expect(panel.className).toContain("wp-glass-glow-gold");
    expect(panel.getAttribute("data-glow")).toBe("gold");
  });

  test("glow='blue' applies the blue glow class", () => {
    render(<GlassPanel glow="blue">x</GlassPanel>);
    expect(screen.getByTestId("glass-panel").className).toContain(
      "wp-glass-glow-blue",
    );
  });

  test("glow defaults to none — no glow class", () => {
    render(<GlassPanel>x</GlassPanel>);
    const cls = screen.getByTestId("glass-panel").className;
    expect(cls).not.toContain("wp-glass-glow");
    expect(screen.getByTestId("glass-panel").getAttribute("data-glow")).toBe(
      "none",
    );
  });

  test("merges a caller className without dropping wp-glass", () => {
    render(
      <GlassPanel className="col-span-2">x</GlassPanel>,
    );
    const cls = screen.getByTestId("glass-panel").className;
    expect(cls).toContain("wp-glass");
    expect(cls).toContain("col-span-2");
  });
});
