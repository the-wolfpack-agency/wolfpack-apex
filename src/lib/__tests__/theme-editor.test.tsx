/**
 * @jest-environment jsdom
 */

/**
 * ThemeEditor — mount-based UI tests.
 *
 * Covers the brand theme editor (colors + Google Font picker) surfaced
 * above the Sections section in BriefForm:
 *
 *   - Mounts <ThemeEditor value={DEFAULT_THEME} onChange={mock} />.
 *   - Every <input>/<select> has an id + name + associated <label>.
 *   - Typing a valid hex into the primary text input fires onChange with
 *     the right shape (colors.primary updated, other colors preserved).
 *   - Typing an INVALID hex (e.g. "not-a-hex") does NOT fire onChange —
 *     the UI lets the user keep typing, the server validator is
 *     authoritative on persist.
 *   - The native <input type=color/> always fires valid hex and
 *     propagates unconditionally.
 *   - Font dropdown contains every entry in CURATED_FONTS.
 *   - Selecting a font fires onChange with {font: {family, googleFontName}}.
 *   - Debounced analytics: rapid edits fire exactly one POST after 500ms.
 *
 * `jest.useFakeTimers()` drives the debounce; we stub global fetch to
 * observe the analytics POST.
 */

import "@testing-library/jest-dom";
import { act, fireEvent, render } from "@testing-library/react";

import { ThemeEditor } from "@/components/sites/ThemeEditor";
import { CURATED_FONTS, DEFAULT_THEME, type SiteTheme } from "@/lib/site-theme";

// ---------------------------------------------------------------------------
// localStorage shim — fetchWithRefresh reads from localStorage to attach
// a Bearer token. jsdom gives us a localStorage already.
// ---------------------------------------------------------------------------

beforeEach(() => {
  // Point the token helper at a value so fetchWithRefresh doesn't bail.
  window.localStorage.setItem("instinct_token", "test-token");
  window.localStorage.setItem("instinct_user", JSON.stringify({ id: "u1" }));
  // Reset global fetch each test.
  (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(() =>
    Promise.resolve(new Response("{}", { status: 200, headers: { "content-type": "application/json" } })),
  );
});

afterEach(() => {
  window.localStorage.clear();
  jest.useRealTimers();
});

describe("ThemeEditor — a11y contract", () => {
  it("every <input>/<select> has an id AND a name", () => {
    const { container } = render(
      <ThemeEditor value={DEFAULT_THEME} onChange={() => {}} />,
    );
    const fields = container.querySelectorAll<HTMLElement>("input, select, textarea");
    expect(fields.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    fields.forEach((el) => {
      const id = el.getAttribute("id");
      const name = el.getAttribute("name");
      if (!id || !name) {
        offenders.push(
          `<${el.tagName.toLowerCase()}> id=${JSON.stringify(id)} name=${JSON.stringify(name)}`,
        );
      }
    });
    expect(offenders).toEqual([]);
  });

  it("every input with an id is reachable from a <label htmlFor=> OR has aria-label", () => {
    const { container } = render(
      <ThemeEditor value={DEFAULT_THEME} onChange={() => {}} />,
    );
    const labels = Array.from(container.querySelectorAll<HTMLLabelElement>("label[for]"));
    const labelTargets = new Set(labels.map((l) => l.getAttribute("for")));
    const fields = container.querySelectorAll<HTMLElement>("input, select, textarea");
    const unlabeled: string[] = [];
    fields.forEach((el) => {
      const id = el.getAttribute("id");
      const ariaLabel = el.getAttribute("aria-label");
      const linked = id ? labelTargets.has(id) : false;
      if (!linked && !ariaLabel) {
        unlabeled.push(`<${el.tagName.toLowerCase()}> id=${id}`);
      }
    });
    expect(unlabeled).toEqual([]);
  });

  it("ids are unique across the mounted editor", () => {
    const { container } = render(
      <ThemeEditor value={DEFAULT_THEME} onChange={() => {}} />,
    );
    const ids = Array.from(container.querySelectorAll<HTMLElement>("[id]")).map(
      (el) => el.getAttribute("id")!,
    );
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    expect(dupes).toEqual([]);
  });
});

describe("ThemeEditor — color editing", () => {
  function findPrimaryHexInput(container: HTMLElement): HTMLInputElement {
    // The hex text input is the one with id ending in "-color-primary-hex".
    const el = container.querySelector<HTMLInputElement>('input[id$="-color-primary-hex"]');
    if (!el) throw new Error("primary hex input not found");
    return el;
  }

  it("typing a valid hex fires onChange with colors.primary updated, other colors preserved", () => {
    const onChange = jest.fn();
    const { container } = render(
      <ThemeEditor value={DEFAULT_THEME} onChange={onChange} />,
    );
    const input = findPrimaryHexInput(container);
    fireEvent.change(input, { target: { value: "#abc123" } });
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as SiteTheme;
    expect(next.colors?.primary).toBe("#abc123");
    // Other colors preserved from DEFAULT_THEME.
    expect(next.colors?.accent).toBe(DEFAULT_THEME.colors?.accent);
    expect(next.colors?.bg).toBe(DEFAULT_THEME.colors?.bg);
    expect(next.colors?.fg).toBe(DEFAULT_THEME.colors?.fg);
    expect(next.colors?.muted).toBe(DEFAULT_THEME.colors?.muted);
    // Font preserved.
    expect(next.font).toEqual(DEFAULT_THEME.font);
  });

  it("typing an INVALID hex does NOT fire onChange (tolerant input, strict propagation)", () => {
    const onChange = jest.fn();
    const { container } = render(
      <ThemeEditor value={DEFAULT_THEME} onChange={onChange} />,
    );
    const input = findPrimaryHexInput(container);
    // Various invalid values.
    fireEvent.change(input, { target: { value: "not-a-hex" } });
    fireEvent.change(input, { target: { value: "#fff" } });
    fireEvent.change(input, { target: { value: "#gggggg" } });
    fireEvent.change(input, { target: { value: "" } });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("each of the 5 color slots has both a swatch (<input type=color>) and a hex text input", () => {
    const { container } = render(
      <ThemeEditor value={DEFAULT_THEME} onChange={() => {}} />,
    );
    const colorSwatches = container.querySelectorAll<HTMLInputElement>('input[type="color"]');
    const hexInputs = container.querySelectorAll<HTMLInputElement>('input[id*="-color-"][id$="-hex"]');
    expect(colorSwatches.length).toBe(5);
    expect(hexInputs.length).toBe(5);
  });

  it("the native color swatch fires onChange with a valid hex", () => {
    const onChange = jest.fn();
    const { container } = render(
      <ThemeEditor value={DEFAULT_THEME} onChange={onChange} />,
    );
    const swatch = container.querySelector<HTMLInputElement>('input[id$="-color-bg-swatch"]');
    expect(swatch).not.toBeNull();
    fireEvent.change(swatch!, { target: { value: "#112233" } });
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as SiteTheme;
    expect(next.colors?.bg).toBe("#112233");
  });

  it("renders even with an undefined theme (uses DEFAULT_THEME swatch values)", () => {
    const { container } = render(
      <ThemeEditor value={undefined} onChange={() => {}} />,
    );
    const swatches = container.querySelectorAll<HTMLInputElement>('input[type="color"]');
    expect(swatches.length).toBe(5);
  });
});

describe("ThemeEditor — font picker", () => {
  it("renders every CURATED_FONTS entry as an <option>", () => {
    const { container } = render(
      <ThemeEditor value={DEFAULT_THEME} onChange={() => {}} />,
    );
    const select = container.querySelector<HTMLSelectElement>('select[name="theme-font-family"]');
    expect(select).not.toBeNull();
    const optionValues = Array.from(select!.querySelectorAll("option"))
      .map((o) => (o as HTMLOptionElement).value)
      .filter((v) => v !== "");
    expect(new Set(optionValues)).toEqual(new Set(CURATED_FONTS.map((f) => f.id)));
  });

  it("selecting a font fires onChange with { font: { family, googleFontName } }", () => {
    const onChange = jest.fn();
    const { container } = render(
      <ThemeEditor value={DEFAULT_THEME} onChange={onChange} />,
    );
    const select = container.querySelector<HTMLSelectElement>('select[name="theme-font-family"]');
    // Pick a specific known font other than the default.
    const target = CURATED_FONTS.find((f) => f.id !== "inter") ?? CURATED_FONTS[1];
    fireEvent.change(select!, { target: { value: target.id } });
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as SiteTheme;
    expect(next.font?.family).toBe(target.family);
    expect(next.font?.googleFontName).toBe(target.name);
    // Colors preserved.
    expect(next.colors).toEqual(DEFAULT_THEME.colors);
  });
});

describe("ThemeEditor — analytics debounce", () => {
  it("rapid color edits debounce to a single /api/analytics POST", () => {
    jest.useFakeTimers();
    const onChange = jest.fn();
    const fetchMock = (global as unknown as { fetch: jest.Mock }).fetch;
    const { container } = render(
      <ThemeEditor value={DEFAULT_THEME} onChange={onChange} projectId="proj-1" />,
    );
    const input = container.querySelector<HTMLInputElement>('input[id$="-color-primary-hex"]')!;
    // Five rapid valid edits within the 500ms debounce window.
    act(() => {
      fireEvent.change(input, { target: { value: "#111111" } });
      fireEvent.change(input, { target: { value: "#222222" } });
      fireEvent.change(input, { target: { value: "#333333" } });
      jest.advanceTimersByTime(200);
      fireEvent.change(input, { target: { value: "#444444" } });
      fireEvent.change(input, { target: { value: "#555555" } });
    });
    // Before the debounce fires, analytics hasn't been POSTed yet.
    expect(fetchMock).not.toHaveBeenCalled();
    act(() => {
      jest.advanceTimersByTime(600);
    });
    // Exactly one POST after the quiet window.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/analytics");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.event).toBe("site.theme_edited");
    expect(body.metadata.project_id).toBe("proj-1");
    // Since all edits were to colors.primary, the changed_keys entry
    // collapses to exactly "colors.primary".
    expect(body.metadata.changed_keys).toBe("colors.primary");
  });

  it("editing multiple distinct keys reports all of them in changed_keys", () => {
    jest.useFakeTimers();
    const onChange = jest.fn();
    const fetchMock = (global as unknown as { fetch: jest.Mock }).fetch;
    const { container } = render(
      <ThemeEditor value={DEFAULT_THEME} onChange={onChange} projectId="proj-2" />,
    );
    const primary = container.querySelector<HTMLInputElement>('input[id$="-color-primary-hex"]')!;
    const bg = container.querySelector<HTMLInputElement>('input[id$="-color-bg-hex"]')!;
    const fontSelect = container.querySelector<HTMLSelectElement>('select[name="theme-font-family"]')!;
    const target = CURATED_FONTS.find((f) => f.id !== "inter")!;
    act(() => {
      fireEvent.change(primary, { target: { value: "#112233" } });
      fireEvent.change(bg, { target: { value: "#445566" } });
      fireEvent.change(fontSelect, { target: { value: target.id } });
      jest.advanceTimersByTime(600);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    const keys = String(body.metadata.changed_keys).split(",").sort();
    expect(keys).toEqual(["colors.bg", "colors.primary", "font.family"]);
  });
});
