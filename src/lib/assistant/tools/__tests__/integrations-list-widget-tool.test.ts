/**
 * integrations_list_widget — intent matching + auto-discovery.
 */

const mockTrackEvent = jest.fn();

jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrackEvent(...a),
}));
jest.mock("@/lib/db", () => ({ safeQuery: jest.fn() }));
jest.mock("@/lib/search/providers", () => ({
  SEARCH_PROVIDERS: [
    { type: "calendar", name: "Calendar", countKey: "calendar", isEnabled: () => true, search: async () => [] },
    { type: "emails", name: "Email", countKey: "emails", isEnabled: () => true, search: async () => [] },
    { type: "vercel", name: "Vercel deployments", countKey: "vercel", isEnabled: () => true, search: async () => [] },
  ],
}));

import { integrationsListWidgetTool } from "@/lib/assistant/tools/integrations-list-widget-tool";

const match = (q: string) => integrationsListWidgetTool.matchIntent!(q);
const CTX = { userId: "u1", userRole: "cto" };

beforeEach(() => {
  mockTrackEvent.mockReset();
});

describe("intent matching", () => {
  test.each([
    "list integrations",
    "show all integrations",
    "what integrations do I have",
    "show all widgets",
    "what can the assistant do",
    "see my integrations",
  ])("'%s' matches", (q) => {
    expect(match(q)).not.toBeNull();
  });

  test.each([
    "show vercel deploys for wolfpack-auto",
    "what's my revenue",
    "find emails",
  ])("'%s' does NOT match", (q) => {
    expect(match(q)).toBeNull();
  });
});

describe("handler", () => {
  test("returns auto-discovered integrations grouped by category", async () => {
    const r = await integrationsListWidgetTool.handler({}, CTX);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.widget?.kind).toBe("integrations_list");
    expect(r.data?.integrationCount).toBeGreaterThanOrEqual(3);
    // The 3 mocked providers + any registered widget-only tools
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "assistant.widget_offered",
      "u1",
      "cto",
      expect.objectContaining({ widget_kind: "integrations_list", ok: true }),
    );
  });
});
