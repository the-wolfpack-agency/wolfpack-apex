/** @jest-environment jsdom */
 
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

  test("each stage shows a Before / Now comparison so non-technical users see what's replaced", () => {
    render(<AutomationFlowDiagram />);
    const stages = ["feeds", "parsers", "snapshots", "assembler", "exceptions", "review", "sharepoint"];
    for (const id of stages) {
      const card = screen.getByTestId(`automation-flow-compare-${id}`);
      expect(card.textContent).toMatch(/Before:/);
      expect(card.textContent).toMatch(/Now:/);
    }
    // Spot-check the SharePoint stage references the manual drag-drop
    // and the new one-click upload.
    const sharepoint = screen.getByTestId("automation-flow-compare-sharepoint");
    expect(sharepoint.textContent).toMatch(/drag/i);
    expect(sharepoint.textContent).toMatch(/one click/i);
  });

  test("top-level 'previous vs new' banner names the old tools and the new automated process", () => {
    render(<AutomationFlowDiagram />);
    const banner = screen.getByTestId("automation-flow-tools-replaced");
    // Section labels — neutral, not sales pitch.
    expect(banner.textContent).toMatch(/Previous tools used for this process/);
    expect(banner.textContent).toMatch(/New automated process/);
    // Old toolset listed factually.
    expect(banner.textContent).toMatch(/Outlook/);
    expect(banner.textContent).toMatch(/Excel/);
    expect(banner.textContent).toMatch(/Cognito/);
    expect(banner.textContent).toMatch(/Word/);
    expect(banner.textContent).toMatch(/OneDrive/);
    expect(banner.textContent).toMatch(/SharePoint/);
    // New: one Instinct page.
    expect(banner.textContent).toMatch(/Instinct/);
    expect(banner.textContent).toMatch(/One page/);
  });

  test("user-facing copy contains no em-dash characters (style guide: avoid em dashes)", () => {
    render(<AutomationFlowDiagram />);
    const body = screen.getByTestId("automation-flow-body");
    // U+2014 EM DASH or U+2013 EN DASH.
    expect(body.textContent ?? "").not.toMatch(/[—–]/);
  });
});
