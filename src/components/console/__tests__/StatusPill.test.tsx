/**
 * @jest-environment jsdom
 *
 * StatusPill + severity vocabulary. Asserts: each status word maps to the
 * right tone/token, label override, forced tone, dot show/hide, capitalized
 * display, and unknown → neutral.
 */

import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { StatusPill } from "@/components/console";
import { toneForStatus, colorForStatus, TONE_VAR } from "@/components/console";

describe("toneForStatus — the single severity vocabulary", () => {
  test.each([
    ["critical", "error"],
    ["high", "error"],
    ["failed", "error"],
    ["medium", "warning"],
    ["pending", "warning"],
    ["low", "info"],
    ["running", "info"],
    ["scanning", "info"],
    ["resolved", "success"],
    ["passed", "success"],
    ["healthy", "success"],
    ["featured", "gold"],
    ["something-else", "neutral"],
  ])("'%s' → %s tone", (status, tone) => {
    expect(toneForStatus(status)).toBe(tone);
  });

  test("is case-insensitive and tolerates spaces/hyphens", () => {
    expect(toneForStatus("CRITICAL")).toBe("error");
    expect(toneForStatus("In Progress")).toBe("info");
    expect(toneForStatus("in-progress")).toBe("info");
  });

  test("null/undefined/empty → neutral", () => {
    expect(toneForStatus(null)).toBe("neutral");
    expect(toneForStatus(undefined)).toBe("neutral");
    expect(toneForStatus("")).toBe("neutral");
  });

  test("colorForStatus returns the token expression for the tone", () => {
    expect(colorForStatus("critical")).toBe(TONE_VAR.error);
    expect(colorForStatus("resolved")).toBe(TONE_VAR.success);
    expect(colorForStatus("unknown")).toBe(TONE_VAR.neutral);
  });
});

describe("StatusPill — render + variants", () => {
  test("renders the status as its label by default", () => {
    render(<StatusPill status="critical" />);
    const pill = screen.getByTestId("status-pill");
    expect(pill).toHaveTextContent("critical");
    expect(pill.getAttribute("data-tone")).toBe("error");
    expect(pill.getAttribute("data-status")).toBe("critical");
  });

  test("uses the error token color for a critical status", () => {
    render(<StatusPill status="critical" />);
    expect(screen.getByTestId("status-pill").style.color).toBe(TONE_VAR.error);
  });

  test("success status uses the success token", () => {
    render(<StatusPill status="resolved" />);
    expect(screen.getByTestId("status-pill").style.color).toBe(
      TONE_VAR.success,
    );
  });

  test("custom label overrides the status text", () => {
    render(<StatusPill status="high" label="High severity" />);
    expect(screen.getByTestId("status-pill")).toHaveTextContent(
      "High severity",
    );
  });

  test("forced tone wins over the status-derived tone", () => {
    render(<StatusPill status="critical" tone="gold" />);
    const pill = screen.getByTestId("status-pill");
    expect(pill.getAttribute("data-tone")).toBe("gold");
    expect(pill.style.color).toBe(TONE_VAR.gold);
  });

  test("renders a dot by default and hides it when hideDot", () => {
    const { rerender } = render(<StatusPill status="running" />);
    expect(screen.getByTestId("status-pill-dot")).toBeInTheDocument();
    rerender(<StatusPill status="running" hideDot />);
    expect(screen.queryByTestId("status-pill-dot")).not.toBeInTheDocument();
  });

  test("unknown status falls back to neutral tone (empty-vocabulary state)", () => {
    render(<StatusPill status="wibble" />);
    expect(screen.getByTestId("status-pill").getAttribute("data-tone")).toBe(
      "neutral",
    );
  });
});
