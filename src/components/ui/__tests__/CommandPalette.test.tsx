/**
 * @jest-environment jsdom
 */
import React from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom";

const pushMock = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

import CommandPalette from "@/components/ui/CommandPalette";

beforeEach(() => {
  jest.clearAllMocks();
});

describe("CommandPalette", () => {
  it("renders nothing by default", () => {
    render(<CommandPalette role="cto" />);
    expect(screen.queryByTestId("command-palette")).not.toBeInTheDocument();
  });

  it("opens on Cmd+K and closes on Escape", () => {
    render(<CommandPalette role="cto" />);
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(screen.getByTestId("command-palette")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("command-palette")).not.toBeInTheDocument();
  });

  it("filters routes by query", () => {
    render(<CommandPalette role="cto" />);
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const input = screen.getByTestId("command-palette-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "knowledge" } });
    expect(screen.getByTestId("command-palette-item-0")).toHaveAttribute("data-href", "/knowledge");
  });

  it("Enter navigates to highlighted route + closes palette", () => {
    render(<CommandPalette role="cto" />);
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const input = screen.getByTestId("command-palette-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "knowledge" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(pushMock).toHaveBeenCalledWith("/knowledge");
    expect(screen.queryByTestId("command-palette")).not.toBeInTheDocument();
  });

  it("ArrowDown moves activeIndex through results", () => {
    render(<CommandPalette role="cto" />);
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const input = screen.getByTestId("command-palette-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "" } });
    // First item active by default
    expect(screen.getByTestId("command-palette-item-0").getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getByTestId("command-palette-item-1").getAttribute("aria-selected")).toBe("true");
  });

  it("role-filters routes — ops user does not see Financials", () => {
    render(<CommandPalette role="ops" />);
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const input = screen.getByTestId("command-palette-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "financ" } });
    // No result — Financials is gated to ceo/cto/evp.
    expect(screen.queryByTestId("command-palette-item-0")).not.toBeInTheDocument();
    expect(screen.getByTestId("command-palette-empty")).toBeInTheDocument();
  });

  it("evp user CAN see Financials (org-chart contract)", () => {
    render(<CommandPalette role="evp" />);
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const input = screen.getByTestId("command-palette-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "financ" } });
    expect(screen.getByTestId("command-palette-item-0")).toHaveAttribute("data-href", "/financials");
  });

  it("empty state shows the typed query", () => {
    render(<CommandPalette role="cto" />);
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const input = screen.getByTestId("command-palette-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "zxqw" } });
    expect(screen.getByTestId("command-palette-empty").textContent).toContain('"zxqw"');
  });
});
