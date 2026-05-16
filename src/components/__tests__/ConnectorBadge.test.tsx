/**
 * @jest-environment jsdom
 *
 * ConnectorBadge — DOM-level tests proving the source-attribution badge
 * renders for each vendor we support. This is the regression guard for
 * the 2026-05-16 demo bug: after switching from the inline "*— Source: X*"
 * footer to a styled badge, the badge silently failed to render in
 * production for several iterations because the conditional gate was
 * threaded through too many layers of InstinctChat.
 *
 * The fix: badge is a self-contained component with a `null` return for
 * the falsy case, so callers can render it unconditionally without an
 * outer && gate that's easy to break.
 */

import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { ConnectorBadge, resolveConnectorStyle } from "@/components/ConnectorBadge";

describe("ConnectorBadge — renders for known vendors", () => {
  test.each([
    ["salesforce", "Salesforce"],
    ["hubspot", "HubSpot"],
    ["github", "GitHub"],
    ["quickbooks", "QuickBooks"],
    ["jira", "Jira"],
    ["zendesk", "Zendesk"],
  ])("%s → label '%s'", (connector, expectedLabel) => {
    render(<ConnectorBadge connector={connector} />);
    const badge = screen.getByTestId(`connector-badge-${connector}`);
    expect(badge).toBeInTheDocument();
    expect(badge.textContent).toBe(expectedLabel);
  });
});

describe("ConnectorBadge — degenerate inputs render nothing (caller can render unconditionally)", () => {
  test("undefined → renders null", () => {
    const { container } = render(<ConnectorBadge connector={undefined} />);
    expect(container.firstChild).toBeNull();
  });

  test("null → renders null", () => {
    const { container } = render(<ConnectorBadge connector={null} />);
    expect(container.firstChild).toBeNull();
  });

  test("empty string → renders null (the falsy gate covers it)", () => {
    const { container } = render(<ConnectorBadge connector="" />);
    expect(container.firstChild).toBeNull();
  });
});

describe("ConnectorBadge — unknown vendor still renders (never silently invisible)", () => {
  test("custom-vendor-x → raw name as label", () => {
    render(<ConnectorBadge connector="custom-vendor-x" />);
    const badge = screen.getByTestId("connector-badge-custom-vendor-x");
    expect(badge).toBeInTheDocument();
    expect(badge.textContent).toBe("custom-vendor-x");
  });
});

describe("resolveConnectorStyle — pure resolution", () => {
  test("known vendor returns brand color + capitalized label", () => {
    const style = resolveConnectorStyle("salesforce");
    expect(style.label).toBe("Salesforce");
    expect(style.color).toBe("#00a1e0");
  });

  test("unknown vendor falls back to the raw name + muted color", () => {
    const style = resolveConnectorStyle("custom");
    expect(style.label).toBe("custom");
    expect(style.color).toContain("--wp-text-muted");
  });
});
