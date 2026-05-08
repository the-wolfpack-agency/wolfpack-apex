/**
 * @jest-environment jsdom
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import Skeleton from "@/components/ui/Skeleton";

describe("Skeleton", () => {
  it("renders with default props", () => {
    render(<Skeleton testId="default-skeleton" />);
    const el = screen.getByTestId("default-skeleton");
    expect(el).toBeInTheDocument();
    expect(el).toHaveAttribute("aria-hidden", "true");
  });

  it("respects width and height props", () => {
    render(<Skeleton testId="sized" width={120} height={32} />);
    const el = screen.getByTestId("sized");
    expect(el.style.width).toBe("120px");
    expect(el.style.height).toBe("32px");
  });

  it("Skeleton.Lines renders the requested number of lines", () => {
    const { container } = render(<Skeleton.Lines lines={4} />);
    expect(container.querySelectorAll("[data-testid='skeleton']").length).toBe(4);
  });

  it("Skeleton.Card renders a single block at the requested height", () => {
    render(<Skeleton.Card height={140} />);
    const el = screen.getByTestId("skeleton");
    expect(el.style.height).toBe("140px");
  });
});
