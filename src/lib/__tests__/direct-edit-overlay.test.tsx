/**
 * @jest-environment jsdom
 */

/**
 * DirectEditOverlay — Path C Phase 4 · Stream U2.
 *
 * Component-level tests for the click-to-edit overlay. We render the
 * real RenderBrief into jsdom, stub `window.parent` so the overlay
 * thinks it lives inside the editor shell, and then exercise:
 *
 *   - Hover adds the outline class.
 *   - Clicking a heading opens the toolbar + flips to contentEditable.
 *   - Enter commits with a well-formed `text.edit` postMessage.
 *   - Escape discards the edit with no postMessage.
 *   - Clicking a CTA opens the CTA toolbar; Save dispatches `cta.edit`.
 *   - Clicking a section (empty margin) shows the SectionToolbar.
 *     ArrowUp button dispatches `section.reorder`.
 *   - Public share-link path: when `?mode=edit` is missing the preview
 *     page never mounts DirectEditOverlay (verified by absence).
 *   - Sanitization: pasted HTML never leaves as innerHTML — text.edit
 *     carries `textContent` only.
 *   - Analytics: every new event fires with the expected metadata.
 */

import "@testing-library/jest-dom";
import { act, render, cleanup, fireEvent } from "@testing-library/react";
import { RenderBrief } from "@/components/sites/render-brief";
import {
  DirectEditOverlay,
  sanitizeEditableText,
} from "@/components/sites/DirectEditOverlay";
import { DirectEditToggle } from "@/components/sites/DirectEditToggle";
import { INSTINCT_EDIT_ORIGIN } from "@/lib/preview-postmessage";
import type { SiteBrief } from "@/lib/sites-schema";

function makeBrief(): SiteBrief {
  return {
    client: "acme",
    product: { name: "Acme", tagline: "We ship" },
    pages: [
      {
        route: "/",
        sections: [
          {
            type: "hero",
            heading: "Welcome to Acme",
            body: "We help you ship software.",
            cta: { label: "Get started", href: "/get-started" },
          },
          { type: "text", heading: "Features", body: "Lots of features." },
          {
            type: "callout",
            heading: "Next steps",
            body: "Book a demo.",
            cta: { label: "Book", href: "/book" },
          },
        ],
      },
    ],
  };
}

let parentPosts: Array<{ data: unknown; origin: string }> = [];
let analyticsEvents: Array<{
  event: string;
  metadata: Record<string, string | number | boolean>;
}> = [];

beforeEach(() => {
  parentPosts = [];
  analyticsEvents = [];
  const stubParent = {
    location: { origin: window.location.origin },
    postMessage: (data: unknown, origin: string) => {
      parentPosts.push({ data, origin });
    },
  };
  Object.defineProperty(window, "parent", {
    value: stubParent,
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  cleanup();
  Object.defineProperty(window, "parent", {
    value: window,
    configurable: true,
    writable: true,
  });
});

function mountEditMode(brief: SiteBrief = makeBrief()) {
  return render(
    <div>
      <RenderBrief brief={brief} page={0} />
      <DirectEditOverlay
        pageIndex={0}
        sectionCount={brief.pages[0].sections.length}
        onAnalyticsEvent={(event, metadata) =>
          analyticsEvents.push({ event, metadata })
        }
      />
    </div>,
  );
}

function postsOfType(type: string) {
  return parentPosts.filter(
    (p) => (p.data as { type?: string })?.type === type,
  );
}

describe("DirectEditOverlay — DOM contract", () => {
  it("does NOT fire any postMessage on mount (unlike the legacy InlineEditOverlay)", () => {
    mountEditMode();
    // The legacy overlay fires `ready`; DirectEditOverlay does not — the
    // caller owns the toggle signal.
    expect(parentPosts.length).toBe(0);
  });

  it("adds the hover class on mouseenter of a heading", () => {
    mountEditMode();
    const heading = document.querySelector(
      '[data-section-type="hero"] h1',
    ) as HTMLElement;
    expect(heading).toBeTruthy();
    act(() => {
      heading.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    });
    expect(heading.classList.contains("instinct-direct-edit-hover")).toBe(true);
  });

  it("clicking a heading flips it to contentEditable + opens toolbar", () => {
    mountEditMode();
    const heading = document.querySelector(
      '[data-section-type="hero"] h1',
    ) as HTMLElement;
    act(() => {
      heading.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(heading.getAttribute("contenteditable")).toBe("true");
    const toolbar = document.querySelector(
      '[data-testid="direct-edit-toolbar"]',
    );
    expect(toolbar).toBeTruthy();
    expect(toolbar!.getAttribute("data-kind")).toBe("heading");
  });

  it("Enter commits the heading and dispatches a text.edit postMessage", () => {
    mountEditMode();
    const heading = document.querySelector(
      '[data-section-type="hero"] h1',
    ) as HTMLElement;
    act(() => {
      heading.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    heading.textContent = "Shipped Faster";
    act(() => {
      heading.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    const edits = postsOfType("text.edit");
    expect(edits.length).toBe(1);
    const msg = edits[0].data as Record<string, unknown>;
    expect(msg.origin).toBe(INSTINCT_EDIT_ORIGIN);
    expect(msg.field).toBe("heading");
    expect(msg.pageIndex).toBe(0);
    expect(msg.sectionIndex).toBe(0);
    expect(msg.value).toBe("Shipped Faster");
    // ContentEditable cleared.
    expect(heading.getAttribute("contenteditable")).toBeNull();
  });

  it("Escape discards the edit with NO postMessage fired", () => {
    mountEditMode();
    const heading = document.querySelector(
      '[data-section-type="hero"] h1',
    ) as HTMLElement;
    act(() => {
      heading.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    heading.textContent = "Rejected";
    const before = postsOfType("text.edit").length;
    act(() => {
      heading.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(postsOfType("text.edit").length).toBe(before);
    expect(heading.getAttribute("contenteditable")).toBeNull();
  });

  it("clicking a CTA prevents navigation and opens the CTA toolbar", () => {
    mountEditMode();
    const cta = document.querySelector(
      '[data-testid="hero-cta"]',
    ) as HTMLAnchorElement;
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
    act(() => {
      cta.dispatchEvent(ev);
    });
    expect(ev.defaultPrevented).toBe(true);
    const toolbar = document.querySelector(
      '[data-testid="direct-edit-toolbar"]',
    );
    expect(toolbar).toBeTruthy();
    expect(toolbar!.getAttribute("data-kind")).toBe("cta");
    const labelInput = document.querySelector(
      '[data-testid="direct-edit-cta-label"]',
    ) as HTMLInputElement;
    expect(labelInput.value).toBe("Get started");
  });

  it("CTA round-trip: change label and Save dispatches cta.edit with new value", () => {
    mountEditMode();
    const cta = document.querySelector(
      '[data-testid="hero-cta"]',
    ) as HTMLAnchorElement;
    act(() => {
      cta.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    const labelInput = document.querySelector(
      '[data-testid="direct-edit-cta-label"]',
    ) as HTMLInputElement;
    act(() => {
      fireEvent.change(labelInput, { target: { value: "Book a demo" } });
    });
    const saveBtn = document.querySelector(
      '[data-testid="direct-edit-cta-save"]',
    ) as HTMLButtonElement;
    act(() => {
      saveBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const ctaEdits = postsOfType("cta.edit");
    // Two messages: label + href
    expect(ctaEdits.length).toBe(2);
    const labelEdit = ctaEdits.find(
      (p) => (p.data as Record<string, string>).field === "label",
    );
    expect(labelEdit).toBeDefined();
    expect((labelEdit!.data as Record<string, unknown>).value).toBe(
      "Book a demo",
    );
  });

  it("section toolbar: clicking Up button dispatches section.reorder", () => {
    mountEditMode();
    // Click the 3rd section container (callout) to select it. We click
    // the section element itself (not its inner heading) to hit the
    // section-level handler.
    const callout = document.querySelector(
      '[data-section-type="callout"]',
    ) as HTMLElement;
    act(() => {
      callout.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const toolbar = document.querySelector(
      '[data-testid="direct-edit-toolbar"]',
    );
    expect(toolbar!.getAttribute("data-kind")).toBe("section");
    const upBtn = document.querySelector(
      '[data-testid="direct-edit-section-up"]',
    ) as HTMLButtonElement;
    act(() => {
      upBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const reorders = postsOfType("section.reorder");
    expect(reorders.length).toBe(1);
    const msg = reorders[0].data as Record<string, unknown>;
    expect(msg.pageIndex).toBe(0);
    expect(msg.fromIndex).toBe(2);
    expect(msg.toIndex).toBe(1);
  });

  it("section toolbar Up is disabled at the top boundary", () => {
    mountEditMode();
    const hero = document.querySelector(
      '[data-section-type="hero"]',
    ) as HTMLElement;
    act(() => {
      hero.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const upBtn = document.querySelector(
      '[data-testid="direct-edit-section-up"]',
    ) as HTMLButtonElement;
    expect(upBtn.disabled).toBe(true);
  });

  it("section toolbar Duplicate dispatches section.duplicate", () => {
    mountEditMode();
    const text = document.querySelector(
      '[data-section-type="text"]',
    ) as HTMLElement;
    act(() => {
      text.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const dup = document.querySelector(
      '[data-testid="direct-edit-section-duplicate"]',
    ) as HTMLButtonElement;
    act(() => {
      dup.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const dups = postsOfType("section.duplicate");
    expect(dups.length).toBe(1);
    expect((dups[0].data as Record<string, unknown>).sectionIndex).toBe(1);
  });

  it("section toolbar Delete dispatches section.delete after confirm", () => {
    const spy = jest.spyOn(window, "confirm").mockReturnValue(true);
    try {
      mountEditMode();
      const text = document.querySelector(
        '[data-section-type="text"]',
      ) as HTMLElement;
      act(() => {
        text.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      const del = document.querySelector(
        '[data-testid="direct-edit-section-delete"]',
      ) as HTMLButtonElement;
      act(() => {
        del.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      const dels = postsOfType("section.delete");
      expect(dels.length).toBe(1);
      expect((dels[0].data as Record<string, unknown>).sectionIndex).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("section Delete is skipped when confirm returns false", () => {
    const spy = jest.spyOn(window, "confirm").mockReturnValue(false);
    try {
      mountEditMode();
      const text = document.querySelector(
        '[data-section-type="text"]',
      ) as HTMLElement;
      act(() => {
        text.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      const del = document.querySelector(
        '[data-testid="direct-edit-section-delete"]',
      ) as HTMLButtonElement;
      act(() => {
        del.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      expect(postsOfType("section.delete").length).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("click on a CTA inside a hero does not select the hero section", () => {
    mountEditMode();
    const cta = document.querySelector(
      '[data-testid="hero-cta"]',
    ) as HTMLAnchorElement;
    act(() => {
      cta.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    const toolbar = document.querySelector(
      '[data-testid="direct-edit-toolbar"]',
    );
    // The toolbar kind must be "cta", never "section" — proves
    // stopPropagation worked.
    expect(toolbar!.getAttribute("data-kind")).toBe("cta");
  });
});

describe("DirectEditOverlay — security / sanitization", () => {
  it("sanitizeEditableText strips HTML and normalizes whitespace", () => {
    expect(sanitizeEditableText("<script>alert(1)</script>Hello")).toBe(
      "Hello",
    );
    expect(sanitizeEditableText("<b>Bold</b>  and   plain")).toBe(
      "Bold and plain",
    );
    expect(sanitizeEditableText("  trimmed   ")).toBe("trimmed");
  });

  it("pasted HTML into a contentEditable is sanitized before text.edit fires", () => {
    mountEditMode();
    const heading = document.querySelector(
      '[data-section-type="hero"] h1',
    ) as HTMLElement;
    act(() => {
      heading.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    // Simulate a paste by setting innerHTML with tags. The commit path
    // must unwrap those into plain text before emitting.
    heading.innerHTML = "<b>Shipped</b> <i>fast</i>";
    act(() => {
      heading.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    const edits = postsOfType("text.edit");
    expect(edits.length).toBe(1);
    const value = (edits[0].data as Record<string, unknown>).value as string;
    expect(value).toBe("Shipped fast");
    // Assert there's no angle bracket left in the shipped value.
    expect(value).not.toMatch(/[<>]/);
  });
});

describe("DirectEditOverlay — public share link invariant", () => {
  it("mounting WITHOUT the overlay leaves no toolbar, no editable outline", () => {
    // Mimics ?mode=edit missing — preview page renders RenderBrief only.
    render(<RenderBrief brief={makeBrief()} page={0} />);
    expect(
      document.querySelector('[data-testid="direct-edit-toolbar"]'),
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="direct-edit-overlay-style"]'),
    ).toBeNull();
    // Clicking a heading does nothing — no contentEditable, no posts.
    const heading = document.querySelector(
      '[data-section-type="hero"] h1',
    ) as HTMLElement;
    act(() => {
      heading.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(heading.getAttribute("contenteditable")).toBeNull();
    expect(parentPosts.length).toBe(0);
  });
});

describe("DirectEditOverlay — analytics", () => {
  it("fires direct_edit.element_clicked on heading click", () => {
    mountEditMode();
    const heading = document.querySelector(
      '[data-section-type="hero"] h1',
    ) as HTMLElement;
    act(() => {
      heading.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const hits = analyticsEvents.filter(
      (e) => e.event === "direct_edit.element_clicked",
    );
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].metadata.element_type).toBe("heading");
  });

  it("fires direct_edit.text_committed on Enter with section_id + field", () => {
    mountEditMode();
    const heading = document.querySelector(
      '[data-section-type="hero"] h1',
    ) as HTMLElement;
    act(() => {
      heading.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    heading.textContent = "New";
    act(() => {
      heading.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    const hits = analyticsEvents.filter(
      (e) => e.event === "direct_edit.text_committed",
    );
    expect(hits.length).toBe(1);
    expect(hits[0].metadata.section_id).toBe(0);
    expect(hits[0].metadata.field).toBe("heading");
  });

  it("fires direct_edit.cta_committed on Save", () => {
    mountEditMode();
    const cta = document.querySelector(
      '[data-testid="hero-cta"]',
    ) as HTMLAnchorElement;
    act(() => {
      cta.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    const save = document.querySelector(
      '[data-testid="direct-edit-cta-save"]',
    ) as HTMLButtonElement;
    act(() => {
      save.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const hits = analyticsEvents.filter(
      (e) => e.event === "direct_edit.cta_committed",
    );
    expect(hits.length).toBe(1);
    expect(hits[0].metadata.section_id).toBe(0);
  });

  it("fires direct_edit.section_reordered_via_canvas on toolbar arrow", () => {
    mountEditMode();
    const callout = document.querySelector(
      '[data-section-type="callout"]',
    ) as HTMLElement;
    act(() => {
      callout.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const up = document.querySelector(
      '[data-testid="direct-edit-section-up"]',
    ) as HTMLButtonElement;
    act(() => {
      up.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const hits = analyticsEvents.filter(
      (e) => e.event === "direct_edit.section_reordered_via_canvas",
    );
    expect(hits.length).toBe(1);
    expect(hits[0].metadata.from_idx).toBe(2);
    expect(hits[0].metadata.to_idx).toBe(1);
  });
});

describe("DirectEditToggle — analytics + aria", () => {
  it("fires direct_edit.enabled on click when off → on", () => {
    let state = false;
    const events: Array<{
      event: string;
      metadata: Record<string, string | number | boolean>;
    }> = [];
    const { rerender } = render(
      <DirectEditToggle
        enabled={state}
        onToggle={(v) => {
          state = v;
        }}
        onAnalyticsEvent={(event, metadata) => events.push({ event, metadata })}
        siteId="site-123"
      />,
    );
    const btn = document.querySelector(
      '[data-testid="direct-edit-toggle"]',
    ) as HTMLButtonElement;
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    act(() => {
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(state).toBe(true);
    expect(events.length).toBe(1);
    expect(events[0].event).toBe("direct_edit.enabled");
    expect(events[0].metadata.site_id).toBe("site-123");

    // Now re-render as enabled and click again to check .disabled event
    rerender(
      <DirectEditToggle
        enabled={true}
        onToggle={(v) => {
          state = v;
        }}
        onAnalyticsEvent={(event, metadata) => events.push({ event, metadata })}
        siteId="site-123"
      />,
    );
    const btn2 = document.querySelector(
      '[data-testid="direct-edit-toggle"]',
    ) as HTMLButtonElement;
    expect(btn2.getAttribute("aria-pressed")).toBe("true");
    act(() => {
      btn2.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(events[events.length - 1].event).toBe("direct_edit.disabled");
  });
});
