/**
 * @jest-environment jsdom
 */
import React from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import Tooltip from "@/components/ui/Tooltip";

describe("Tooltip", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it("does not render the tooltip until hover", () => {
    render(
      <Tooltip label="Click to open">
        <button>Btn</button>
      </Tooltip>,
    );
    expect(screen.queryByTestId("tooltip")).not.toBeInTheDocument();
  });

  it("shows after hover delay, hides on mouse leave", () => {
    render(
      <Tooltip label="Click to open" delayMs={200}>
        <button>Btn</button>
      </Tooltip>,
    );
    fireEvent.mouseEnter(screen.getByText("Btn").parentElement!);
    expect(screen.queryByTestId("tooltip")).not.toBeInTheDocument();
    act(() => {
      jest.advanceTimersByTime(200);
    });
    expect(screen.getByTestId("tooltip")).toBeInTheDocument();
    expect(screen.getByTestId("tooltip").textContent).toContain("Click to open");

    fireEvent.mouseLeave(screen.getByText("Btn").parentElement!);
    expect(screen.queryByTestId("tooltip")).not.toBeInTheDocument();
  });

  it("renders the optional hint line", () => {
    render(
      <Tooltip label="primary" hint="kbd: ⌘K" delayMs={0}>
        <button>Btn</button>
      </Tooltip>,
    );
    fireEvent.focus(screen.getByText("Btn").parentElement!);
    act(() => {
      jest.advanceTimersByTime(0);
    });
    const tip = screen.getByTestId("tooltip");
    expect(tip.textContent).toContain("primary");
    expect(tip.textContent).toContain("kbd: ⌘K");
  });

  it("dismisses on Escape", () => {
    render(
      <Tooltip label="x" delayMs={0}>
        <button>Btn</button>
      </Tooltip>,
    );
    fireEvent.focus(screen.getByText("Btn").parentElement!);
    act(() => {
      jest.advanceTimersByTime(0);
    });
    expect(screen.getByTestId("tooltip")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("tooltip")).not.toBeInTheDocument();
  });
});
