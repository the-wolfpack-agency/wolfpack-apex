/**
 * @jest-environment jsdom
 */

/**
 * ViewportToggle — unit + a11y contract tests.
 *
 * Covers Stream P1 of Path C Phase 1: the Mobile / Tablet / Desktop
 * switch above the preview iframe on the sites edit page.
 *
 * What we pin here:
 *   - Initial render: active value gets the `aria-pressed="true"` +
 *     active styling hook (`data-active="true"`).
 *   - Click → onChange(next) fires with the canonical string value.
 *   - All three buttons carry aria-pressed reflecting the current
 *     value (never stale, never missing).
 *   - Keyboard nav: ArrowRight / ArrowLeft cycle through the toolbar
 *     (toolbar WAI-ARIA pattern) and fire onChange; Home / End jump.
 *   - Exported `VIEWPORT_WIDTHS` constant has exactly the three
 *     documented keys at their documented pixel widths. Guarded here
 *     so the edit page + Playwright spec always read the same numbers.
 */

import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";

import ViewportToggle, {
  VIEWPORT_WIDTHS,
  type Viewport,
} from "@/components/sites/ViewportToggle";

describe("VIEWPORT_WIDTHS constant", () => {
  it("exposes exactly mobile/tablet/desktop at their documented widths", () => {
    expect(Object.keys(VIEWPORT_WIDTHS).sort()).toEqual(
      ["desktop", "mobile", "tablet"].sort(),
    );
    expect(VIEWPORT_WIDTHS.mobile).toBe(390);
    expect(VIEWPORT_WIDTHS.tablet).toBe(834);
    expect(VIEWPORT_WIDTHS.desktop).toBe(1280);
  });
});

describe("ViewportToggle — rendering", () => {
  it("renders three buttons labelled Mobile / Tablet / Desktop", () => {
    render(<ViewportToggle value="desktop" onChange={() => {}} />);
    expect(screen.getByTestId("viewport-toggle-mobile")).toBeInTheDocument();
    expect(screen.getByTestId("viewport-toggle-tablet")).toBeInTheDocument();
    expect(screen.getByTestId("viewport-toggle-desktop")).toBeInTheDocument();
  });

  it("marks the active button aria-pressed=true and the others false", () => {
    render(<ViewportToggle value="desktop" onChange={() => {}} />);
    const desktop = screen.getByTestId("viewport-toggle-desktop");
    const mobile = screen.getByTestId("viewport-toggle-mobile");
    const tablet = screen.getByTestId("viewport-toggle-tablet");
    expect(desktop).toHaveAttribute("aria-pressed", "true");
    expect(desktop).toHaveAttribute("data-active", "true");
    expect(mobile).toHaveAttribute("aria-pressed", "false");
    expect(mobile).toHaveAttribute("data-active", "false");
    expect(tablet).toHaveAttribute("aria-pressed", "false");
  });

  it("renders a toolbar with an accessible label", () => {
    render(<ViewportToggle value="mobile" onChange={() => {}} />);
    const toolbar = screen.getByRole("toolbar");
    expect(toolbar).toHaveAttribute("aria-label", "Preview viewport size");
  });

  it("mobile-collapsed select exposes all three options", () => {
    render(<ViewportToggle value="tablet" onChange={() => {}} />);
    const select = screen.getByTestId("viewport-toggle-select") as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).toEqual(["mobile", "tablet", "desktop"]);
    expect(select.value).toBe("tablet");
  });
});

describe("ViewportToggle — interactions", () => {
  it("clicking Mobile calls onChange with 'mobile'", () => {
    const onChange = jest.fn<void, [Viewport]>();
    render(<ViewportToggle value="desktop" onChange={onChange} />);
    fireEvent.click(screen.getByTestId("viewport-toggle-mobile"));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("mobile");
  });

  it("clicking Tablet calls onChange with 'tablet'", () => {
    const onChange = jest.fn<void, [Viewport]>();
    render(<ViewportToggle value="desktop" onChange={onChange} />);
    fireEvent.click(screen.getByTestId("viewport-toggle-tablet"));
    expect(onChange).toHaveBeenCalledWith("tablet");
  });

  it("clicking the currently-active button still emits (parent can no-op)", () => {
    // The component does not short-circuit same-value clicks — the page
    // decides whether to no-op. This keeps the component dumb + testable.
    const onChange = jest.fn<void, [Viewport]>();
    render(<ViewportToggle value="desktop" onChange={onChange} />);
    fireEvent.click(screen.getByTestId("viewport-toggle-desktop"));
    expect(onChange).toHaveBeenCalledWith("desktop");
  });

  it("select change fires onChange with the right viewport", () => {
    const onChange = jest.fn<void, [Viewport]>();
    render(<ViewportToggle value="desktop" onChange={onChange} />);
    fireEvent.change(screen.getByTestId("viewport-toggle-select"), {
      target: { value: "mobile" },
    });
    expect(onChange).toHaveBeenCalledWith("mobile");
  });
});

describe("ViewportToggle — keyboard nav (toolbar pattern)", () => {
  it("ArrowRight on toolbar moves selection forward", () => {
    const onChange = jest.fn<void, [Viewport]>();
    render(<ViewportToggle value="mobile" onChange={onChange} />);
    const toolbar = screen.getByRole("toolbar");
    fireEvent.keyDown(toolbar, { key: "ArrowRight" });
    expect(onChange).toHaveBeenCalledWith("tablet");
  });

  it("ArrowRight wraps from desktop → mobile", () => {
    const onChange = jest.fn<void, [Viewport]>();
    render(<ViewportToggle value="desktop" onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole("toolbar"), { key: "ArrowRight" });
    expect(onChange).toHaveBeenCalledWith("mobile");
  });

  it("ArrowLeft on toolbar moves selection backward", () => {
    const onChange = jest.fn<void, [Viewport]>();
    render(<ViewportToggle value="tablet" onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole("toolbar"), { key: "ArrowLeft" });
    expect(onChange).toHaveBeenCalledWith("mobile");
  });

  it("ArrowLeft wraps from mobile → desktop", () => {
    const onChange = jest.fn<void, [Viewport]>();
    render(<ViewportToggle value="mobile" onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole("toolbar"), { key: "ArrowLeft" });
    expect(onChange).toHaveBeenCalledWith("desktop");
  });

  it("Home jumps to first, End jumps to last", () => {
    const onChange = jest.fn<void, [Viewport]>();
    render(<ViewportToggle value="tablet" onChange={onChange} />);
    const toolbar = screen.getByRole("toolbar");
    fireEvent.keyDown(toolbar, { key: "Home" });
    expect(onChange).toHaveBeenLastCalledWith("mobile");
    fireEvent.keyDown(toolbar, { key: "End" });
    expect(onChange).toHaveBeenLastCalledWith("desktop");
  });
});
