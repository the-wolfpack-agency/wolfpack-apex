/**
 * @jest-environment jsdom
 *
 * AssistantStarterPrompts — connection-aware category filtering.
 *
 * The bug this catches: a user with no Salesforce hookup clicks
 * "top 3 deals" and gets a 400. We shipped them the chip; the
 * failure is on us. These tests lock the rule that a category is
 * hidden unless at least one of its required providers reports
 * `connected: true` from /api/integrations/status.
 *
 * Internal-only categories (Knowledge & memory) must always render
 * so the empty state never collapses to nothing.
 */

import "@testing-library/jest-dom";
import { render, screen, waitFor, act, fireEvent } from "@testing-library/react";

const mockFetch = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: unknown[]) => mockFetch(...a),
  jsonHeaders: () => ({ "Content-Type": "application/json" }),
}));

import {
  AssistantStarterPrompts,
  filterCategoriesByStatus,
} from "@/components/AssistantStarterPrompts";

beforeEach(() => {
  mockFetch.mockReset();
});

function mockStatus(body: unknown) {
  mockFetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => body,
  });
}

describe("filterCategoriesByStatus (pure)", () => {
  /* Chip shape changed from `string` to `{ text, description }` when we
   * added native-tooltip hover hints. The filter logic is independent
   * of chip shape; we use minimal placeholder chips here so the suite
   * still exercises the gating rules. */
  const stub = (t: string) => ({ text: t, description: `desc-${t}` });
  const cats = [
    { title: "Always", emoji: "📚", prompts: [stub("x")] },
    {
      title: "Needs MS",
      emoji: "📅",
      prompts: [stub("x")],
      requires: { any: ["microsoft" as const] },
    },
    {
      title: "Needs CRM",
      emoji: "🤝",
      prompts: [stub("x")],
      requires: { any: ["salesforce" as const, "hubspot" as const] },
    },
  ];

  test("loading state (status=null) shows only no-requirement categories", () => {
    const out = filterCategoriesByStatus(cats, null);
    expect(out.map((c) => c.title)).toEqual(["Always"]);
  });

  test("hides all gated categories when nothing is connected", () => {
    const out = filterCategoriesByStatus(cats, {});
    expect(out.map((c) => c.title)).toEqual(["Always"]);
  });

  test("shows microsoft-gated category when microsoft connected", () => {
    const out = filterCategoriesByStatus(cats, {
      microsoft: { connected: true },
    });
    expect(out.map((c) => c.title)).toEqual(["Always", "Needs MS"]);
  });

  test("CRM shown when EITHER salesforce OR hubspot connected", () => {
    const sfOnly = filterCategoriesByStatus(cats, {
      salesforce: { connected: true },
    });
    expect(sfOnly.map((c) => c.title)).toContain("Needs CRM");
    const hsOnly = filterCategoriesByStatus(cats, {
      hubspot: { connected: true },
    });
    expect(hsOnly.map((c) => c.title)).toContain("Needs CRM");
  });

  test("CRM hidden when neither salesforce nor hubspot connected", () => {
    const out = filterCategoriesByStatus(cats, {
      microsoft: { connected: true },
    });
    expect(out.map((c) => c.title)).not.toContain("Needs CRM");
  });
});

describe("AssistantStarterPrompts (rendered)", () => {
  test("before status loads, only internal-only category is rendered", () => {
    /* Never resolve so we stay in the loading branch. */
    mockFetch.mockReturnValue(new Promise(() => {}));
    render(<AssistantStarterPrompts onPick={() => undefined} />);
    expect(screen.getByText(/Knowledge & memory/)).toBeInTheDocument();
    expect(screen.queryByText(/^Widgets$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^GitHub$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Salesforce \/ HubSpot/)).not.toBeInTheDocument();
  });

  test("no integrations connected → only Knowledge & memory + connect hint", async () => {
    mockStatus({});
    render(<AssistantStarterPrompts onPick={() => undefined} />);
    await waitFor(() => {
      expect(screen.getByTestId("starter-prompts-connect-hint")).toBeInTheDocument();
    });
    expect(screen.getByText(/Knowledge & memory/)).toBeInTheDocument();
    expect(screen.queryByText(/^Widgets$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^GitHub$/)).not.toBeInTheDocument();
    /* Hint mentions every gated provider group. */
    const hint = screen.getByTestId("starter-prompts-connect-hint");
    expect(hint.textContent).toMatch(/Microsoft 365/);
    expect(hint.textContent).toMatch(/CRM/);
    expect(hint.textContent).toMatch(/GitHub/);
  });

  test("microsoft + github connected → CRM still hidden, hint mentions only CRM", async () => {
    mockStatus({
      microsoft: { connected: true },
      github: { connected: true },
    });
    render(<AssistantStarterPrompts onPick={() => undefined} />);
    await waitFor(() => {
      expect(screen.getByTestId("starter-prompts-connect-hint")).toBeInTheDocument();
    });
    expect(screen.getByText(/^Widgets$/)).toBeInTheDocument();
    expect(screen.getByText(/^GitHub$/)).toBeInTheDocument();
    expect(screen.getByText(/Calendar & Mail/)).toBeInTheDocument();
    expect(screen.queryByText(/Salesforce \/ HubSpot/)).not.toBeInTheDocument();
    const hint = screen.getByTestId("starter-prompts-connect-hint");
    expect(hint.textContent).toMatch(/CRM/);
    expect(hint.textContent).not.toMatch(/Microsoft 365/);
    expect(hint.textContent).not.toMatch(/GitHub/);
  });

  test("everything connected → no connect hint", async () => {
    mockStatus({
      microsoft: { connected: true },
      salesforce: { connected: true },
      github: { connected: true },
    });
    render(<AssistantStarterPrompts onPick={() => undefined} />);
    await waitFor(() => {
      expect(screen.getByText(/Salesforce \/ HubSpot/)).toBeInTheDocument();
    });
    expect(screen.queryByTestId("starter-prompts-connect-hint")).not.toBeInTheDocument();
  });

  test("status fetch failure → falls back to internal-only categories, no crash", async () => {
    mockFetch.mockRejectedValue(new Error("network"));
    await act(async () => {
      render(<AssistantStarterPrompts onPick={() => undefined} />);
      /* Let the rejected promise settle. */
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.getByText(/Knowledge & memory/)).toBeInTheDocument();
    });
  });

  /* --- Hover tooltips (native `title=`) ----------------------------
   * Every chip must carry a non-empty, prompt-specific `title` so a
   * hovering user sees what the chip will actually do before they
   * click. Catches the regression where the data shape ships back to
   * `string[]` and the tooltip silently disappears. */

  test("every visible chip has a non-empty title attribute", async () => {
    mockStatus({
      microsoft: { connected: true },
      salesforce: { connected: true },
      github: { connected: true },
    });
    const { container } = render(
      <AssistantStarterPrompts onPick={() => undefined} />,
    );
    await waitFor(() => {
      expect(screen.getByText(/Salesforce \/ HubSpot/)).toBeInTheDocument();
    });
    /* Categories now collapse by default (2026-05-19 layout fix), so
     * expand every visible header before asserting chips. */
    const categoryToggles = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        'button[data-testid^="starter-category-toggle-"]',
      ),
    );
    for (const toggle of categoryToggles) {
      fireEvent.click(toggle);
    }
    const chipButtons = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        'button[data-testid^="starter-prompt-"]',
      ),
    );
    expect(chipButtons.length).toBeGreaterThan(0);
    for (const btn of chipButtons) {
      const title = btn.getAttribute("title") ?? "";
      expect(title.trim()).not.toEqual("");
    }
  });

  test("chip title matches the description from buildStarterCategories", async () => {
    mockStatus({
      microsoft: { connected: true },
    });
    render(<AssistantStarterPrompts onPick={() => undefined} />);
    /* Wait for status to resolve so the Widgets category is visible. */
    await waitFor(() => {
      expect(screen.getByText(/^Widgets$/)).toBeInTheDocument();
    });
    /* Sections default to collapsed; expand Widgets + Knowledge & memory
     * before asserting their chip titles. */
    fireEvent.click(screen.getByTestId("starter-category-toggle-widgets"));
    fireEvent.click(
      screen.getByTestId("starter-category-toggle-knowledge-memory"),
    );
    /* "briefing" is the first Widgets chip and lives in a category
     * gated on `microsoft`, so it only renders once status resolves. */
    const briefing = screen.getByTestId("starter-prompt-widgets-briefing");
    expect(briefing.getAttribute("title")).toBe(
      "Your morning summary: greeting, today's schedule, unread email digest, and action items.",
    );
    /* Knowledge & memory is always visible; assert one of its chips too
     * to lock the wire from data shape to DOM for the no-requires path. */
    const okrs = screen.getByTestId("starter-prompt-knowledge-memory-what-are-our-OKRs");
    expect(okrs.getAttribute("title")).toBe(
      "Pulls the team's current objectives and key results from the knowledge base.",
    );
  });
});
