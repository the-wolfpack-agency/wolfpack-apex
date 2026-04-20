/**
 * @jest-environment jsdom
 */

/**
 * InspectorPanel — component tests.
 *
 * Covers:
 *   - Empty-state when no section is selected.
 *   - Field render for hero (heading, body, cta/label, cta/href,
 *     backgroundImage) and quote (adds attribution).
 *   - Changing a field fires onFieldChange + onAnalyticsFieldEdited
 *     with the correct path.
 *   - readSectionField resolves nested paths without throwing.
 *   - fieldSpecsForSection returns type-specific field sets.
 */

import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import InspectorPanel, {
  fieldSpecsForSection,
  readSectionField,
} from "@/components/sites/InspectorPanel";
import type { BriefSection } from "@/lib/sites-schema";

describe("fieldSpecsForSection — per-type field sets", () => {
  it("returns heading + body + CTA for text sections", () => {
    const specs = fieldSpecsForSection({ type: "text", heading: "" });
    const paths = specs.map((s) => s.path);
    expect(paths).toContain("heading");
    expect(paths).toContain("body");
    expect(paths).toContain("cta/label");
    expect(paths).toContain("cta/href");
  });

  it("adds backgroundImage for hero + banner", () => {
    expect(
      fieldSpecsForSection({ type: "hero" }).some((s) => s.path === "backgroundImage"),
    ).toBe(true);
    expect(
      fieldSpecsForSection({ type: "banner" }).some((s) => s.path === "backgroundImage"),
    ).toBe(true);
  });

  it("adds attribution for quote", () => {
    expect(
      fieldSpecsForSection({ type: "quote" }).some((s) => s.path === "attribution"),
    ).toBe(true);
  });
});

describe("readSectionField — safe nested reads", () => {
  const section: BriefSection = {
    type: "hero",
    heading: "Welcome",
    cta: { label: "Go", href: "/go" },
  };

  it("reads direct fields", () => {
    expect(readSectionField(section, "heading")).toBe("Welcome");
  });

  it("reads nested cta fields via slash path", () => {
    expect(readSectionField(section, "cta/label")).toBe("Go");
    expect(readSectionField(section, "cta/href")).toBe("/go");
  });

  it("returns '' when the path is missing without throwing", () => {
    expect(readSectionField({ type: "text" }, "cta/label")).toBe("");
    expect(readSectionField({ type: "text" }, "heading")).toBe("");
  });
});

describe("InspectorPanel — rendering + wiring", () => {
  it("renders the empty state when section is null", () => {
    render(
      <InspectorPanel
        section={null}
        sectionIndex={null}
        onFieldChange={jest.fn()}
      />,
    );
    expect(screen.getByTestId("studio-inspector-empty")).toBeInTheDocument();
  });

  it("renders every applicable field for a hero section", () => {
    render(
      <InspectorPanel
        section={{ type: "hero", heading: "A", body: "B" }}
        sectionIndex={0}
        onFieldChange={jest.fn()}
      />,
    );
    expect(screen.getByTestId("studio-inspector-field-heading")).toBeInTheDocument();
    expect(screen.getByTestId("studio-inspector-field-body")).toBeInTheDocument();
    expect(screen.getByTestId("studio-inspector-field-cta-label")).toBeInTheDocument();
    expect(screen.getByTestId("studio-inspector-field-cta-href")).toBeInTheDocument();
    expect(
      screen.getByTestId("studio-inspector-field-backgroundImage"),
    ).toBeInTheDocument();
  });

  it("editing a field fires onFieldChange with slash-delimited path + value", () => {
    const onFieldChange = jest.fn();
    render(
      <InspectorPanel
        section={{ type: "hero", heading: "A" }}
        sectionIndex={0}
        onFieldChange={onFieldChange}
      />,
    );
    const input = screen.getByTestId(
      "studio-inspector-field-heading",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "New heading" } });
    expect(onFieldChange).toHaveBeenCalledWith("heading", "New heading");
  });

  it("editing fires onAnalyticsFieldEdited with the field path", () => {
    const onFieldChange = jest.fn();
    const onAnalytics = jest.fn();
    render(
      <InspectorPanel
        section={{ type: "hero", heading: "" }}
        sectionIndex={2}
        onFieldChange={onFieldChange}
        onAnalyticsFieldEdited={onAnalytics}
      />,
    );
    const ctaInput = screen.getByTestId(
      "studio-inspector-field-cta-label",
    ) as HTMLInputElement;
    fireEvent.change(ctaInput, { target: { value: "Book now" } });
    expect(onFieldChange).toHaveBeenCalledWith("cta/label", "Book now");
    expect(onAnalytics).toHaveBeenCalledWith(
      "cta/label",
      "2:hero",
    );
  });
});
