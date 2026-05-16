/**
 * source-footer helper — every connector-backed tool answer ends with
 * "*— Source: <Vendor>*" so users can always tell which system the
 * data came from. Critical when a workspace has multiple CRMs
 * connected and the same query could in principle return data from
 * either.
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
  test("appends italic Source: line to the answer", () => {
    const out = withSourceFooter("Found 1 contact.", "salesforce");
    expect(out).toContain("Found 1 contact.");
    expect(out).toContain("*— Source: Salesforce*");
    /* Separator is a blank line — answer + footer don't run together. */
    expect(out).toMatch(/Found 1 contact\.\s*\n\s*\n\s*\*— Source/);
  });

  test("strips trailing whitespace from answer before appending", () => {
    const out = withSourceFooter("Found 1 contact.   \n\n\n", "hubspot");
    /* Exactly one blank line between answer and footer. */
    const split = out.split("\n\n");
    expect(split).toHaveLength(2);
    expect(split[1]).toBe("*— Source: HubSpot*");
  });

  test("returns answer unchanged when connector is null/undefined/empty", () => {
    expect(withSourceFooter("Found 1 contact.", null)).toBe("Found 1 contact.");
    expect(withSourceFooter("Found 1 contact.", undefined)).toBe("Found 1 contact.");
    expect(withSourceFooter("Found 1 contact.", "")).toBe("Found 1 contact.");
  });
});
