/**
 * @jest-environment jsdom
 */

/**
 * StudioShell — integration tests.
 *
 * Verifies:
 *   - Renders PublishBar, TabDock, preview iframe, InspectorPanel.
 *   - fires `studio.opened` once on mount.
 *   - Tab switching fires `studio.tab_changed` with metadata.
 *   - Section selection in the outline fires `studio.section_selected`
 *     and populates the Inspector with the section's fields.
 *   - Editing a field in the Inspector fires `studio.inspector_field_edited`
 *     and updates the brief via `onBriefChange`.
 *   - applyInlineReorder + the pure helpers handle section ops.
 */

import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import StudioShell, {
  addSectionToBrief,
  deleteSectionInBrief,
  duplicateSectionInBrief,
  replaceSectionInBrief,
  setSectionField,
} from "@/components/sites/StudioShell";
import type { Brief } from "@/components/sites/BriefForm";

function makeBrief(): Brief {
  return {
    client: "acme",
    product: { name: "Acme" },
    pages: [
      {
        route: "/",
        sections: [
          {
            type: "hero",
            heading: "Old hero",
            body: "Old body",
            cta: { label: "Go", href: "/go" },
          },
          { type: "text", heading: "Second section", body: "Words" },
        ],
      },
    ],
  };
}

function renderShell(overrides: Partial<React.ComponentProps<typeof StudioShell>> = {}) {
  const onBriefChange = jest.fn();
  const onPublish = jest.fn();
  const onAnalytics = jest.fn();
  const brief = overrides.brief ?? makeBrief();
  const utils = render(
    <StudioShell
      siteId="site_1"
      siteName="Acme"
      clientSlug="acme"
      brief={brief}
      savedBrief={brief}
      lastPublishedBrief={brief}
      deployStatus="idle"
      previewUrl={null}
      onBriefChange={onBriefChange}
      onPublish={onPublish}
      onAnalytics={onAnalytics}
      tabContent={{
        chat: <div data-testid="chat-tab-body">chat body</div>,
        theme: <div data-testid="theme-tab-body">theme body</div>,
        assets: <div data-testid="assets-tab-body">assets body</div>,
        seo: <div data-testid="seo-tab-body">seo body</div>,
        forms: <div data-testid="forms-tab-body">forms body</div>,
        domain: <div data-testid="domain-tab-body">domain body</div>,
        share: <div data-testid="share-tab-body">share body</div>,
        versions: <div data-testid="versions-tab-body">versions body</div>,
        comments: <div data-testid="comments-tab-body">comments body</div>,
        acceptance: <div data-testid="acceptance-tab-body">acceptance body</div>,
      }}
      {...overrides}
    />,
  );
  return { ...utils, onBriefChange, onPublish, onAnalytics, brief };
}

describe("StudioShell — three-pane layout renders", () => {
  it("renders PublishBar, TabDock, center pane, and right-rail inspector", () => {
    renderShell();
    expect(screen.getByTestId("studio-shell")).toBeInTheDocument();
    expect(screen.getByTestId("studio-publish-bar")).toBeInTheDocument();
    expect(screen.getByTestId("studio-tab-dock-rail")).toBeInTheDocument();
    expect(screen.getByTestId("studio-center-pane")).toBeInTheDocument();
    expect(screen.getByTestId("studio-right-rail")).toBeInTheDocument();
    expect(screen.getByTestId("studio-preview-iframe")).toBeInTheDocument();
  });

  it("exposes every tab in the rail with role=tab + aria-selected", () => {
    renderShell();
    const expectedTabs = [
      "chat",
      "sections",
      "theme",
      "assets",
      "seo",
      "forms",
      "domain",
      "share",
      "versions",
      "comments",
    ];
    for (const t of expectedTabs) {
      const tab = screen.getByTestId(`studio-tab-dock-tab-${t}`);
      expect(tab).toBeInTheDocument();
      expect(tab.getAttribute("role")).toBe("tab");
    }
    const chatTab = screen.getByTestId("studio-tab-dock-tab-chat");
    expect(chatTab.getAttribute("aria-selected")).toBe("true");
  });
});

describe("StudioShell — analytics", () => {
  it("fires studio.opened exactly once on mount", async () => {
    const { onAnalytics } = renderShell();
    await waitFor(() => {
      expect(onAnalytics).toHaveBeenCalledWith(
        "studio.opened",
        expect.objectContaining({ site_id: "site_1" }),
      );
    });
    const openedCalls = onAnalytics.mock.calls.filter(
      (c) => c[0] === "studio.opened",
    );
    expect(openedCalls).toHaveLength(1);
  });

  it("fires studio.tab_changed with the target tab_name", () => {
    const { onAnalytics } = renderShell();
    onAnalytics.mockClear();
    fireEvent.click(screen.getByTestId("studio-tab-dock-tab-sections"));
    expect(onAnalytics).toHaveBeenCalledWith(
      "studio.tab_changed",
      expect.objectContaining({ tab_name: "sections" }),
    );
  });

  it("fires studio.publish_clicked with the pending edit count", () => {
    const brief = makeBrief();
    const edited: Brief = {
      ...brief,
      pages: [
        {
          ...brief.pages[0],
          sections: [
            {
              ...brief.pages[0].sections[0],
              heading: "NEW",
            },
            brief.pages[0].sections[1],
          ],
        },
      ],
    };
    const { onAnalytics, onPublish } = renderShell({
      brief: edited,
      lastPublishedBrief: brief,
    });
    onAnalytics.mockClear();
    const publishBtn = screen.getByTestId("studio-publish-bar-publish-btn");
    expect(publishBtn).not.toBeDisabled();
    fireEvent.click(publishBtn);
    expect(onAnalytics).toHaveBeenCalledWith(
      "studio.publish_clicked",
      expect.objectContaining({ pending_edit_count: expect.any(Number) }),
    );
    expect(onPublish).toHaveBeenCalled();
  });
});

describe("StudioShell — section selection + inspector wiring", () => {
  it("clicking a section row populates the inspector with its fields", () => {
    const { onAnalytics } = renderShell();
    // Switch to the Sections tab to reveal the outline.
    fireEvent.click(screen.getByTestId("studio-tab-dock-tab-sections"));
    // Click first section.
    fireEvent.click(screen.getByTestId("studio-section-outline-row-0"));
    // Inspector should now show the hero section's fields.
    const inspector = screen.getByTestId("studio-inspector");
    expect(inspector.getAttribute("data-section-type")).toBe("hero");
    const headingInput = screen.getByTestId(
      "studio-inspector-field-heading",
    ) as HTMLInputElement;
    expect(headingInput.value).toBe("Old hero");
    // Analytics fired.
    expect(onAnalytics).toHaveBeenCalledWith(
      "studio.section_selected",
      expect.objectContaining({ section_id: "0:hero" }),
    );
  });

  it("editing an Inspector field calls onBriefChange + fires studio.inspector_field_edited", () => {
    const { onBriefChange, onAnalytics } = renderShell();
    fireEvent.click(screen.getByTestId("studio-tab-dock-tab-sections"));
    fireEvent.click(screen.getByTestId("studio-section-outline-row-0"));
    const headingInput = screen.getByTestId(
      "studio-inspector-field-heading",
    ) as HTMLInputElement;
    act(() => {
      fireEvent.change(headingInput, { target: { value: "New hero" } });
    });
    expect(onBriefChange).toHaveBeenCalled();
    const lastCall = onBriefChange.mock.calls[onBriefChange.mock.calls.length - 1];
    const nextBrief: Brief = lastCall[0];
    expect(nextBrief.pages[0].sections[0].heading).toBe("New hero");
    expect(onAnalytics).toHaveBeenCalledWith(
      "studio.inspector_field_edited",
      expect.objectContaining({ field_path: "heading" }),
    );
  });
});

describe("StudioShell — pure helpers", () => {
  it("setSectionField deep-sets a field and creates intermediate objects", () => {
    const section = { type: "hero" as const, heading: "A" };
    const next = setSectionField(section, "cta/label", "Click me");
    expect(next.cta?.label).toBe("Click me");
    // Input must not be mutated.
    expect(section).toEqual({ type: "hero", heading: "A" });
  });

  it("replaceSectionInBrief swaps a section without mutating the input", () => {
    const brief = makeBrief();
    const replaced = replaceSectionInBrief(brief, 0, 0, {
      type: "hero",
      heading: "Z",
    });
    expect(replaced.pages[0].sections[0].heading).toBe("Z");
    expect(brief.pages[0].sections[0].heading).toBe("Old hero");
  });

  it("duplicateSectionInBrief inserts a copy immediately after the source", () => {
    const brief = makeBrief();
    const dup = duplicateSectionInBrief(brief, 0, 0);
    expect(dup.pages[0].sections).toHaveLength(3);
    expect(dup.pages[0].sections[1].heading).toBe("Old hero");
    expect(brief.pages[0].sections).toHaveLength(2);
  });

  it("deleteSectionInBrief removes at the given index", () => {
    const brief = makeBrief();
    const next = deleteSectionInBrief(brief, 0, 0);
    expect(next.pages[0].sections).toHaveLength(1);
    expect(next.pages[0].sections[0].type).toBe("text");
  });

  it("addSectionToBrief appends a blank of the requested type", () => {
    const brief = makeBrief();
    const next = addSectionToBrief(brief, 0, "pricing");
    expect(next.pages[0].sections).toHaveLength(3);
    expect(next.pages[0].sections[2].type).toBe("pricing");
  });
});
