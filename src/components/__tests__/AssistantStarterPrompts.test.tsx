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
import { render, screen, waitFor, act } from "@testing-library/react";

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
  const cats = [
    { title: "Always", emoji: "📚", prompts: ["x"] },
    {
      title: "Needs MS",
      emoji: "📅",
      prompts: ["x"],
      requires: { any: ["microsoft" as const] },
    },
    {
      title: "Needs CRM",
      emoji: "🤝",
      prompts: ["x"],
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
});
