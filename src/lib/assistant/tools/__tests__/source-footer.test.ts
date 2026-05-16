/**
 * source-footer helper — the chat UI renders the connector source as a
 * styled badge (canonical source of truth). This helper is a no-op for
 * the chat surface but exposes `inline: true` for non-UI consumers
 * (analytics export, transcript download).
 */

import { withSourceFooter, sourceLabel } from "@/lib/assistant/tools/source-footer";

describe("sourceLabel — known vendors get friendly capitalized names", () => {
  test.each([
    ["salesforce", "Salesforce"],
    ["hubspot", "HubSpot"],
    ["quickbooks", "QuickBooks"],
    ["jira", "Jira"],
    ["github", "GitHub"],
    ["zendesk", "Zendesk"],
    ["rest-default", "REST (generic)"],
  ])("'%s' → '%s'", (input, expected) => {
    expect(sourceLabel(input)).toBe(expected);
  });

  test("unknown connector falls back to raw name (still informative)", () => {
    expect(sourceLabel("custom-vendor-x")).toBe("custom-vendor-x");
  });
});

describe("withSourceFooter", () => {
  test("no-op by default — UI renders connectorSource as a badge instead", () => {
    expect(withSourceFooter("Found 1 contact.", "salesforce")).toBe("Found 1 contact.");
  });

  test("returns answer unchanged when connector is null/undefined/empty (regardless of inline flag)", () => {
    expect(withSourceFooter("Found 1 contact.", null)).toBe("Found 1 contact.");
    expect(withSourceFooter("Found 1 contact.", undefined)).toBe("Found 1 contact.");
    expect(withSourceFooter("Found 1 contact.", "")).toBe("Found 1 contact.");
    expect(withSourceFooter("Found 1 contact.", null, { inline: true })).toBe("Found 1 contact.");
  });

  test("inline: true → appends italic Source: footer (analytics export / transcript path)", () => {
    const out = withSourceFooter("Found 1 contact.", "salesforce", { inline: true });
    expect(out).toContain("Found 1 contact.");
    expect(out).toContain("*— Source: Salesforce*");
    expect(out).toMatch(/Found 1 contact\.\s*\n\s*\n\s*\*— Source/);
  });

  test("inline: true strips trailing whitespace before appending", () => {
    const out = withSourceFooter("Found 1 contact.   \n\n\n", "hubspot", { inline: true });
    const split = out.split("\n\n");
    expect(split).toHaveLength(2);
    expect(split[1]).toBe("*— Source: HubSpot*");
  });
});
