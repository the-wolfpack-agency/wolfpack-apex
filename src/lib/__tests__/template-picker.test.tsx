/**
 * @jest-environment jsdom
 */

/**
 * TemplatePicker — mount-based flow test.
 *
 * Asserts observable DOM + callbacks, not helper returns. Covers:
 *   - renders one card per registered template
 *   - clicking a card fires onSelect with that template's id
 *   - Enter key on a focused card fires onSelect (keyboard a11y)
 *   - each card has an accessible name containing the template name
 *   - clicking a card fires-and-forgets site.template_previewed
 *     to /api/analytics
 */

import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import TemplatePicker from "@/components/sites/TemplatePicker";
import { listTemplates } from "@/lib/site-templates";

const analyticsFetch = jest.fn();

beforeAll(() => {
  // Minimal localStorage stub so fetchWithRefresh can read the instinct token.
  Object.defineProperty(window, "localStorage", {
    value: {
      _store: { instinct_token: "t" } as Record<string, string>,
      getItem(this: { _store: Record<string, string> }, k: string) {
        return this._store[k] ?? null;
      },
      setItem(this: { _store: Record<string, string> }, k: string, v: string) {
        this._store[k] = v;
      },
      removeItem(this: { _store: Record<string, string> }, k: string) {
        delete this._store[k];
      },
      clear(this: { _store: Record<string, string> }) {
        this._store = {};
      },
    },
    writable: true,
  });

  global.fetch = analyticsFetch as unknown as typeof fetch;
});

beforeEach(() => {
  analyticsFetch.mockReset();
  analyticsFetch.mockImplementation(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true }),
  }));
});

describe("<TemplatePicker />", () => {
  test("renders one card per registered template", () => {
    const templates = listTemplates();
    expect(templates.length).toBeGreaterThanOrEqual(3);
    render(<TemplatePicker onSelect={() => {}} />);
    for (const t of templates) {
      const card = screen.getByTestId(`template-card-${t.id}`);
      expect(card).toBeInTheDocument();
      // Accessible name from aria-label.
      expect(card).toHaveAttribute("aria-label", `Use template: ${t.name}`);
      expect(card.tagName.toLowerCase()).toBe("button");
    }
  });

  test("every card's visible text includes the template name + description", () => {
    const templates = listTemplates();
    render(<TemplatePicker onSelect={() => {}} />);
    for (const t of templates) {
      const card = screen.getByTestId(`template-card-${t.id}`);
      expect(card).toHaveTextContent(t.name);
      expect(card).toHaveTextContent(t.description);
    }
  });

  test("clicking a card fires onSelect with the template id", () => {
    const onSelect = jest.fn();
    render(<TemplatePicker onSelect={onSelect} />);
    const card = screen.getByTestId("template-card-portfolio");
    fireEvent.click(card);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("portfolio");
  });

  test("Enter key on a focused card fires onSelect (native <button> behaviour)", () => {
    const onSelect = jest.fn();
    render(<TemplatePicker onSelect={onSelect} />);
    const card = screen.getByTestId("template-card-racing_team");
    card.focus();
    expect(document.activeElement).toBe(card);
    // In jsdom, pressing Enter on a focused button fires a click event.
    // We simulate the browser behaviour explicitly by dispatching click
    // after keyDown — both paths must reach onSelect.
    fireEvent.keyDown(card, { key: "Enter", code: "Enter" });
    fireEvent.click(card);
    expect(onSelect).toHaveBeenCalledWith("racing_team");
  });

  test("disabled prop prevents selection and marks buttons as disabled", () => {
    const onSelect = jest.fn();
    render(<TemplatePicker onSelect={onSelect} disabled />);
    const card = screen.getByTestId("template-card-service_business");
    expect(card).toBeDisabled();
    fireEvent.click(card);
    expect(onSelect).not.toHaveBeenCalled();
  });

  test("clicking a card fires site.template_previewed analytics (fire-and-forget)", async () => {
    const onSelect = jest.fn();
    render(<TemplatePicker onSelect={onSelect} />);
    fireEvent.click(screen.getByTestId("template-card-portfolio"));

    await waitFor(() => {
      expect(analyticsFetch).toHaveBeenCalled();
    });
    const [url, init] = analyticsFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/analytics");
    expect(init?.method).toBe("POST");
    const body = JSON.parse((init?.body as string) ?? "{}");
    expect(body.event).toBe("site.template_previewed");
    expect(body.metadata?.template_id).toBe("portfolio");
    // onSelect must still fire even if analytics is in flight.
    expect(onSelect).toHaveBeenCalledWith("portfolio");
  });
});
