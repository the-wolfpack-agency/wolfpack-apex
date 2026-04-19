/**
 * @jest-environment jsdom
 */

/**
 * ThemeEditor — design-token section UI tests (Path C Phase 1 · P4).
 *
 * Covers the three new collapsible sections (Spacing / Radius / Type scale):
 *   - Sections render as <details> elements, collapsed by default.
 *   - Every token input has id + name + associated <label>.
 *   - Typing a spacing value fires onChange with the nested theme.spacing
 *     object preserving the rest of the theme.
 *   - Empty input → default used as the placeholder (progressive disclosure).
 *   - Changing a token fires `site.design_token_applied` analytics exactly
 *     once per edit (not debounced — per-edit truth for the learning loop).
 *   - Radius + typeScale work the same way.
 *   - Clearing a spacing input removes the key from theme.spacing so the
 *     default wins again.
 */

import "@testing-library/jest-dom";
import { act, fireEvent, render } from "@testing-library/react";

import { ThemeEditor } from "@/components/sites/ThemeEditor";
import { DEFAULT_THEME, type SiteTheme } from "@/lib/site-theme";
import {
  DEFAULT_RADIUS,
  DEFAULT_SPACING,
  DEFAULT_TYPE_SCALE,
} from "@/lib/site-theme-tokens";

beforeEach(() => {
  window.localStorage.setItem("instinct_token", "test-token");
  window.localStorage.setItem("instinct_user", JSON.stringify({ id: "u1" }));
  (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(() =>
    Promise.resolve(
      new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
});

afterEach(() => {
  window.localStorage.clear();
  jest.useRealTimers();
});

describe("ThemeEditor — token sections render", () => {
  it("renders spacing, radius, and type-scale collapsible sections", () => {
    const { getByTestId } = render(
      <ThemeEditor value={DEFAULT_THEME} onChange={() => {}} />,
    );
    expect(getByTestId("theme-spacing")).toBeInTheDocument();
    expect(getByTestId("theme-radius")).toBeInTheDocument();
    expect(getByTestId("theme-typescale")).toBeInTheDocument();
  });

  it("collapses the three token sections by default (details[open]=false)", () => {
    const { getByTestId } = render(
      <ThemeEditor value={DEFAULT_THEME} onChange={() => {}} />,
    );
    for (const id of ["theme-spacing", "theme-radius", "theme-typescale"]) {
      const details = getByTestId(id) as HTMLDetailsElement;
      expect(details.open).toBe(false);
    }
  });

  it("spacing section has one input per DEFAULT_SPACING tier (ids are unique)", () => {
    const { container } = render(
      <ThemeEditor value={DEFAULT_THEME} onChange={() => {}} />,
    );
    const spacingInputs = container.querySelectorAll<HTMLInputElement>(
      'input[data-token-group="spacing"]',
    );
    const tierCount = Object.keys(DEFAULT_SPACING).length;
    expect(spacingInputs.length).toBe(tierCount);
    const ids = Array.from(spacingInputs).map((el) => el.id);
    expect(new Set(ids).size).toBe(tierCount);
  });

  it("radius section has one input per DEFAULT_RADIUS tier", () => {
    const { container } = render(
      <ThemeEditor value={DEFAULT_THEME} onChange={() => {}} />,
    );
    const radiusInputs = container.querySelectorAll<HTMLInputElement>(
      'input[data-token-group="radius"]',
    );
    expect(radiusInputs.length).toBe(Object.keys(DEFAULT_RADIUS).length);
  });

  it("type-scale section has 2 inputs per tier (fontSize + lineHeight)", () => {
    const { container } = render(
      <ThemeEditor value={DEFAULT_THEME} onChange={() => {}} />,
    );
    const typeInputs = container.querySelectorAll<HTMLInputElement>(
      'input[data-token-group="typeScale"]',
    );
    expect(typeInputs.length).toBe(Object.keys(DEFAULT_TYPE_SCALE).length * 2);
  });
});

describe("ThemeEditor — token inputs a11y", () => {
  it("every token input has id + name + label or aria-label", () => {
    const { container } = render(
      <ThemeEditor value={DEFAULT_THEME} onChange={() => {}} />,
    );
    const labels = Array.from(
      container.querySelectorAll<HTMLLabelElement>("label[for]"),
    );
    const labelTargets = new Set(labels.map((l) => l.getAttribute("for")));
    const tokenInputs = container.querySelectorAll<HTMLInputElement>(
      "input[data-token-group]",
    );
    expect(tokenInputs.length).toBeGreaterThan(0);
    tokenInputs.forEach((el) => {
      expect(el.id).toBeTruthy();
      expect(el.getAttribute("name")).toBeTruthy();
      const reachable = labelTargets.has(el.id) || !!el.getAttribute("aria-label");
      expect(reachable).toBe(true);
    });
  });

  it("empty spacing input shows the default as placeholder", () => {
    const { container } = render(
      <ThemeEditor value={DEFAULT_THEME} onChange={() => {}} />,
    );
    const mdInput = container.querySelector<HTMLInputElement>(
      'input[data-token-group="spacing"][data-token-name="md"]',
    );
    expect(mdInput).not.toBeNull();
    expect(mdInput!.placeholder).toBe(DEFAULT_SPACING.md);
  });
});

describe("ThemeEditor — token onChange wiring", () => {
  function findSpacingInput(container: HTMLElement, tier: string) {
    return container.querySelector<HTMLInputElement>(
      `input[data-token-group="spacing"][data-token-name="${tier}"]`,
    );
  }

  it("typing a spacing value fires onChange with theme.spacing updated", () => {
    const onChange = jest.fn();
    const { container } = render(
      <ThemeEditor value={DEFAULT_THEME} onChange={onChange} />,
    );
    const mdInput = findSpacingInput(container, "md")!;
    fireEvent.change(mdInput, { target: { value: "20px" } });
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as SiteTheme;
    expect(next.spacing?.md).toBe("20px");
    // Colors/font preserved from DEFAULT_THEME.
    expect(next.colors).toEqual(DEFAULT_THEME.colors);
    expect(next.font).toEqual(DEFAULT_THEME.font);
  });

  it("clearing a spacing value removes the key so defaults win again", () => {
    const onChange = jest.fn();
    const initial: SiteTheme = {
      ...DEFAULT_THEME,
      spacing: { md: "20px" },
    };
    const { container } = render(
      <ThemeEditor value={initial} onChange={onChange} />,
    );
    const mdInput = findSpacingInput(container, "md")!;
    fireEvent.change(mdInput, { target: { value: "" } });
    const next = onChange.mock.calls[0][0] as SiteTheme;
    expect(next.spacing?.md).toBeUndefined();
  });

  it("typing a radius value fires onChange with theme.radius updated", () => {
    const onChange = jest.fn();
    const { container } = render(
      <ThemeEditor value={DEFAULT_THEME} onChange={onChange} />,
    );
    const fullInput = container.querySelector<HTMLInputElement>(
      'input[data-token-group="radius"][data-token-name="full"]',
    )!;
    fireEvent.change(fullInput, { target: { value: "999px" } });
    const next = onChange.mock.calls[0][0] as SiteTheme;
    expect(next.radius?.full).toBe("999px");
  });

  it("typing a type-scale fontSize AND lineHeight each fires onChange with the correct theme update", () => {
    const onChange = jest.fn();
    const { container } = render(
      <ThemeEditor value={DEFAULT_THEME} onChange={onChange} />,
    );
    const sizeInput = container.querySelector<HTMLInputElement>(
      'input[data-token-group="typeScale"][data-token-name="base.fontSize"]',
    )!;
    const lineInput = container.querySelector<HTMLInputElement>(
      'input[data-token-group="typeScale"][data-token-name="base.lineHeight"]',
    )!;
    fireEvent.change(sizeInput, { target: { value: "17px" } });
    fireEvent.change(lineInput, { target: { value: "26px" } });
    expect(onChange).toHaveBeenCalledTimes(2);
    // First call: fontSize set, lineHeight defaults to the schema default.
    const first = onChange.mock.calls[0][0] as SiteTheme;
    expect(first.typeScale?.base?.fontSize).toBe("17px");
    // Second call: lineHeight set (fontSize defaults because the
    // component doesn't rebuild against the first update in this test).
    const second = onChange.mock.calls[1][0] as SiteTheme;
    expect(second.typeScale?.base?.lineHeight).toBe("26px");
  });
});

describe("ThemeEditor — token analytics", () => {
  it("editing a spacing token fires site.design_token_applied POST", () => {
    const onChange = jest.fn();
    const fetchMock = (global as unknown as { fetch: jest.Mock }).fetch;
    const { container } = render(
      <ThemeEditor
        value={DEFAULT_THEME}
        onChange={onChange}
        projectId="proj-42"
      />,
    );
    const mdInput = container.querySelector<HTMLInputElement>(
      'input[data-token-group="spacing"][data-token-name="md"]',
    )!;
    act(() => {
      fireEvent.change(mdInput, { target: { value: "20px" } });
    });
    expect(fetchMock).toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/analytics");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.event).toBe("site.design_token_applied");
    expect(body.metadata.token_group).toBe("spacing");
    expect(body.metadata.token_name).toBe("md");
    expect(body.metadata.new_value).toBe("20px");
    expect(body.metadata.site_id).toBe("proj-42");
  });

  it("editing a radius token fires analytics with token_group=radius", () => {
    const fetchMock = (global as unknown as { fetch: jest.Mock }).fetch;
    const { container } = render(
      <ThemeEditor
        value={DEFAULT_THEME}
        onChange={() => {}}
        projectId="proj-1"
      />,
    );
    const input = container.querySelector<HTMLInputElement>(
      'input[data-token-group="radius"][data-token-name="sm"]',
    )!;
    act(() => {
      fireEvent.change(input, { target: { value: "6px" } });
    });
    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body.metadata.token_group).toBe("radius");
    expect(body.metadata.token_name).toBe("sm");
    expect(body.metadata.new_value).toBe("6px");
  });

  it("editing a type-scale entry fires analytics with dotted token_name", () => {
    const fetchMock = (global as unknown as { fetch: jest.Mock }).fetch;
    const { container } = render(
      <ThemeEditor
        value={DEFAULT_THEME}
        onChange={() => {}}
        projectId="proj-1"
      />,
    );
    const sizeInput = container.querySelector<HTMLInputElement>(
      'input[data-token-group="typeScale"][data-token-name="2xl.fontSize"]',
    )!;
    act(() => {
      fireEvent.change(sizeInput, { target: { value: "28px" } });
    });
    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body.metadata.token_group).toBe("typeScale");
    expect(body.metadata.token_name).toBe("2xl.fontSize");
    expect(body.metadata.new_value).toBe("28px");
  });
});
