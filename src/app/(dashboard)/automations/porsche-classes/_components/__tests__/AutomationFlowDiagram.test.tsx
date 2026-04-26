/** @jest-environment jsdom */
/* eslint-disable @typescript-eslint/no-explicit-any */
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";

import AutomationFlowDiagram from "@/app/(dashboard)/automations/porsche-classes/_components/AutomationFlowDiagram";

beforeEach(() => {
  try {
    window.localStorage.clear();
  } catch {
    /* noop */
  }
});

describe("<AutomationFlowDiagram />", () => {
  test("renders all 7 stages of the porsche-classes pipeline in order", () => {
    render(<AutomationFlowDiagram />);
    const expected = [
      "feeds",
      "parsers",
      "snapshots",
      "assembler",
      "exceptions",
      "review",
      "sharepoint",
    ];
    for (const id of expected) {
      expect(
        screen.getByTestId(`automation-flow-node-${id}`),
      ).toBeInTheDocument();
    }
    // Order check — DOM order matches the ordered list.
    const rendered = expected.map((id) =>
      screen.getByTestId(`automation-flow-node-${id}`),
    );
    for (let i = 1; i < rendered.length; i++) {
      expect(rendered[i - 1].compareDocumentPosition(rendered[i])).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      );
    }
  });

  test("each stage carries a tone tag (input / process / human / store) for color-coding", () => {
    render(<AutomationFlowDiagram />);
    expect(
      screen.getByTestId("automation-flow-node-feeds"),
    ).toHaveAttribute("data-tone", "input");
    expect(
      screen.getByTestId("automation-flow-node-parsers"),
    ).toHaveAttribute("data-tone", "process");
    expect(
      screen.getByTestId("automation-flow-node-review"),
    ).toHaveAttribute("data-tone", "human");
    expect(
      screen.getByTestId("automation-flow-node-snapshots"),
    ).toHaveAttribute("data-tone", "store");
  });

  test("renders an arrow between every consecutive pair (last node has none)", () => {
    render(<AutomationFlowDiagram />);
    expect(screen.getByTestId("automation-flow-arrow-feeds")).toBeInTheDocument();
    expect(screen.getByTestId("automation-flow-arrow-review")).toBeInTheDocument();
    expect(screen.queryByTestId("automation-flow-arrow-sharepoint")).toBeNull();
  });

  test("collapses + expands on toggle and persists the choice to localStorage", () => {
    render(<AutomationFlowDiagram />);
    // Default: expanded.
    expect(screen.getByTestId("automation-flow-body")).toBeInTheDocument();
    expect(
      screen.getByTestId("automation-flow-toggle"),
    ).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(screen.getByTestId("automation-flow-toggle"));
    expect(screen.queryByTestId("automation-flow-body")).toBeNull();
    expect(
      screen.getByTestId("automation-flow-toggle"),
    ).toHaveAttribute("aria-expanded", "false");
    expect(
      window.localStorage.getItem("instinct.automation_flow.collapsed"),
    ).toBe("1");

    fireEvent.click(screen.getByTestId("automation-flow-toggle"));
    expect(screen.getByTestId("automation-flow-body")).toBeInTheDocument();
    expect(
      window.localStorage.getItem("instinct.automation_flow.collapsed"),
    ).toBe("0");
  });

  test("returning user with collapsed=1 in localStorage starts collapsed", () => {
    window.localStorage.setItem("instinct.automation_flow.collapsed", "1");
    render(<AutomationFlowDiagram />);
    expect(screen.queryByTestId("automation-flow-body")).toBeNull();
    expect(
      screen.getByTestId("automation-flow-toggle"),
    ).toHaveAttribute("aria-expanded", "false");
  });
});
