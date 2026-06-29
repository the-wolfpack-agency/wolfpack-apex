/**
 * @jest-environment jsdom
 *
 * SectionHeader. Asserts: renders the title at the right heading level,
 * optional subtitle/eyebrow/actions, omits the optional slots when absent,
 * and forwards a className.
 */

import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { SectionHeader } from "@/components/console";

describe("SectionHeader", () => {
  test("renders the title as an h2 by default", () => {
    render(<SectionHeader title="Platform scans" />);
    const h = screen.getByRole("heading", { name: "Platform scans" });
    expect(h.tagName).toBe("H2");
  });

  test("honours the `as` heading level", () => {
    render(<SectionHeader title="Agents" as="h1" />);
    expect(
      screen.getByRole("heading", { name: "Agents", level: 1 }),
    ).toBeInTheDocument();
  });

  test("renders subtitle, eyebrow and actions when provided", () => {
    render(
      <SectionHeader
        title="Detail"
        eyebrow="Agent"
        subtitle="last run 2m ago"
        actions={<button>Re-run</button>}
      />,
    );
    expect(screen.getByTestId("section-header-eyebrow")).toHaveTextContent(
      "Agent",
    );
    expect(screen.getByTestId("section-header-subtitle")).toHaveTextContent(
      "last run 2m ago",
    );
    expect(screen.getByTestId("section-header-actions")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Re-run" }),
    ).toBeInTheDocument();
  });

  test("omits optional slots when absent (empty state)", () => {
    render(<SectionHeader title="Bare" />);
    expect(screen.queryByTestId("section-header-eyebrow")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("section-header-subtitle"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("section-header-actions"),
    ).not.toBeInTheDocument();
  });

  test("forwards a className", () => {
    render(<SectionHeader title="x" className="mb-0" />);
    expect(screen.getByTestId("section-header").className).toContain("mb-0");
  });

  describe("responsive overflow contract", () => {
    // jsdom can't measure layout, so we assert the CSS contract that makes a
    // busy actions row wrap/drop below the title instead of clipping the
    // rightmost control (the desktop+mobile overflow bug this kit fixes).
    test("the outer container flex-wraps so actions can drop below the title", () => {
      render(<SectionHeader title="x" actions={<button>a</button>} />);
      expect(screen.getByTestId("section-header").style.flexWrap).toBe("wrap");
    });

    test("the actions slot flex-wraps and can shrink (minWidth:0)", () => {
      render(
        <SectionHeader
          title="x"
          actions={
            <>
              <button>a</button>
              <button>b</button>
              <button>c</button>
            </>
          }
        />,
      );
      const slot = screen.getByTestId("section-header-actions");
      expect(slot.style.flexWrap).toBe("wrap");
      expect(slot.style.minWidth).toBe("0");
    });
  });
});
