/**
 * source-footer helper — every connector-backed tool answer carries
 * "*— Source: <Vendor>*" so attribution survives transcript exports,
 * conversation reload, and any path that drops the connectorSource
 * field. The chat UI strips it at render time and renders as a badge.
 */

import {
  withSourceFooter,
  sourceLabel,
  extractSourceFooter,
  connectorNameFromLabel,
} from "@/lib/assistant/tools/source-footer";

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
  test("appends italic Source: footer by default — survives transcript export + reloads", () => {
    const out = withSourceFooter("Found 1 contact.", "salesforce");
    expect(out).toContain("Found 1 contact.");
    expect(out).toContain("*— Source: Salesforce*");
    expect(out).toMatch(/Found 1 contact\.\s*\n\s*\n\s*\*— Source/);
  });

  test("returns answer unchanged when connector is null/undefined/empty", () => {
    expect(withSourceFooter("Found 1 contact.", null)).toBe("Found 1 contact.");
    expect(withSourceFooter("Found 1 contact.", undefined)).toBe("Found 1 contact.");
    expect(withSourceFooter("Found 1 contact.", "")).toBe("Found 1 contact.");
  });

  test("inline: false → skip footer (caller already attributing elsewhere)", () => {
    expect(withSourceFooter("Found 1 contact.", "salesforce", { inline: false })).toBe(
      "Found 1 contact.",
    );
  });

  test("strips trailing whitespace before appending", () => {
    const out = withSourceFooter("Found 1 contact.   \n\n\n", "hubspot");
    const split = out.split("\n\n");
    expect(split).toHaveLength(2);
    expect(split[1]).toBe("*— Source: HubSpot*");
  });
});

describe("extractSourceFooter — UI strips footer for badge rendering", () => {
  test("extracts label + clean body", () => {
    const answer = "Found 1 contact.\n\n*— Source: Salesforce*";
    const extracted = extractSourceFooter(answer);
    expect(extracted).not.toBeNull();
    expect(extracted?.label).toBe("Salesforce");
    expect(extracted?.bodyWithoutFooter).toBe("Found 1 contact.");
  });

  test("handles trailing whitespace after footer", () => {
    const answer = "Found 1 contact.\n\n*— Source: HubSpot*  \n";
    const extracted = extractSourceFooter(answer);
    expect(extracted?.label).toBe("HubSpot");
  });

  test("returns null when no footer present", () => {
    expect(extractSourceFooter("Plain answer.")).toBeNull();
    expect(extractSourceFooter("Found 1 contact.\n\nNo footer.")).toBeNull();
  });

  test("round-trip: withSourceFooter then extract → original body", () => {
    const body = "Top 3 deals:\n\n1. Acme\n2. Globex\n3. Initech";
    const withFooter = withSourceFooter(body, "salesforce");
    const extracted = extractSourceFooter(withFooter);
    expect(extracted?.bodyWithoutFooter).toBe(body);
    expect(extracted?.label).toBe("Salesforce");
  });
});

describe("connectorNameFromLabel — UI maps label back to canonical name", () => {
  test.each([
    ["Salesforce", "salesforce"],
    ["HubSpot", "hubspot"],
    ["GitHub", "github"],
    ["REST (generic)", "rest-default"],
  ])("'%s' → '%s'", (label, expected) => {
    expect(connectorNameFromLabel(label)).toBe(expected);
  });

  test("unknown label falls back to lowercased original", () => {
    expect(connectorNameFromLabel("CustomVendor")).toBe("customvendor");
  });
});
