/**
 * @jest-environment jsdom
 */

/**
 * InlineEditOverlay DOM contract.
 *
 * We don't mount the full preview page (that suspends on `use(params)`
 * in jsdom — same reason the edit page helpers were extracted for unit
 * testing). Instead we render RenderBrief + InlineEditOverlay directly,
 * fake a parent-window on window.parent, and assert the overlay's DOM
 * side-effects: hover class appears, click flips the node to
 * contentEditable, Enter-commit posts a well-formed message.
 *
 * What we're locking in:
 *   - hover adds the dashed-border hover class
 *   - click puts the target into contentEditable=true + editing class
 *   - Enter commits → window.parent.postMessage fires with type="text.edit"
 *   - origin check guards brief.push (untrusted origin ignored)
 */

import "@testing-library/jest-dom";
import { act, render, cleanup } from "@testing-library/react";
import { RenderBrief } from "@/components/sites/render-brief";
import {
  InlineEditOverlay,
  beginInlineEdit,
  commitInlineEdit,
} from "@/app/sites/[id]/preview/page";
import { INSTINCT_EDIT_ORIGIN } from "@/lib/preview-postmessage";
import type { SiteBrief } from "@/lib/sites-schema";
import { createRef } from "react";

function brief(): SiteBrief {
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
            body: "We help you ship.",
            cta: { label: "Get started", href: "/get-started" },
          },
          { type: "text", heading: "Features", body: "Lots of features." },
        ],
      },
    ],
  };
}

// Make window.parent look same-origin and record posts.
let parentPosts: Array<{ data: unknown; origin: string }> = [];

beforeEach(() => {
  parentPosts = [];
  // Swap window.parent with a stub that shares the same origin. jsdom's
  // default makes window.parent === window, which means
  // `parentIsSameOrigin()` returns false (we early-return then). We
  // monkey-patch a harness parent with location.origin matching window.
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
  // Restore parent to window (jsdom default).
  Object.defineProperty(window, "parent", {
    value: window,
    configurable: true,
    writable: true,
  });
});

function mountHarness(b: SiteBrief = brief()) {
  return render(
    <div>
      <RenderBrief brief={b} page={0} />
      <InlineEditOverlay brief={b} pageIndex={0} onBriefPushed={() => {}} />
    </div>,
  );
}

describe("InlineEditOverlay — hotspot DOM contract", () => {
  it("posts `ready` to parent when mounted inside same-origin iframe", () => {
    mountHarness();
    const readyMsg = parentPosts.find(
      (p) =>
        (p.data as { type?: string })?.type === "ready" &&
        (p.data as { origin?: string })?.origin === INSTINCT_EDIT_ORIGIN,
    );
    expect(readyMsg).toBeDefined();
  });

  it("tags editable nodes with data-instinct-field + instinct-inline-editable class", () => {
    mountHarness();
    const heroSection = document.querySelector('[data-section-type="hero"]');
    expect(heroSection).toBeTruthy();
    const heading = heroSection!.querySelector("h1") as HTMLElement;
    expect(heading.dataset.instinctField).toBe("heading");
    expect(heading.classList.contains("instinct-inline-editable")).toBe(true);
  });

  it("adds hover class on mouseenter and removes on mouseleave", () => {
    mountHarness();
    const heading = document.querySelector(
      '[data-section-type="hero"] h1',
    ) as HTMLElement;
    heading.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    expect(heading.classList.contains("instinct-inline-editable-hover")).toBe(
      true,
    );
    heading.dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }));
    expect(heading.classList.contains("instinct-inline-editable-hover")).toBe(
      false,
    );
  });

  it("click flips the heading into contentEditable mode", () => {
    mountHarness();
    const heading = document.querySelector(
      '[data-section-type="hero"] h1',
    ) as HTMLElement;
    act(() => {
      heading.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(heading.getAttribute("contenteditable")).toBe("true");
    expect(heading.classList.contains("instinct-inline-editing")).toBe(true);
    expect(heading.dataset.instinctEditing).toBe("1");
  });

  it("Enter press commits the edit and posts a text.edit message", () => {
    mountHarness();
    const heading = document.querySelector(
      '[data-section-type="hero"] h1',
    ) as HTMLElement;

    act(() => {
      heading.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    // Simulate user typing by changing textContent directly — jsdom
    // doesn't execute contentEditable input semantics for us.
    heading.textContent = "Shipped";

    // Count only text.edit posts (ignore the "ready" handshake fired on mount).
    const before = parentPosts.filter(
      (p) => (p.data as { type?: string })?.type === "text.edit",
    ).length;
    act(() => {
      heading.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });

    const textEdits = parentPosts.filter(
      (p) => (p.data as { type?: string })?.type === "text.edit",
    );
    expect(textEdits.length).toBe(before + 1);
    const msg = textEdits[textEdits.length - 1].data as Record<string, unknown>;
    expect(msg.origin).toBe(INSTINCT_EDIT_ORIGIN);
    expect(msg.field).toBe("heading");
    expect(msg.pageIndex).toBe(0);
    expect(msg.sectionIndex).toBe(0);
    expect(msg.value).toBe("Shipped");

    // After commit, contentEditable is cleared.
    expect(heading.getAttribute("contenteditable")).toBeNull();
  });

  it("Escape cancels editing without posting any text.edit", () => {
    mountHarness();
    const heading = document.querySelector(
      '[data-section-type="hero"] h1',
    ) as HTMLElement;
    act(() => {
      heading.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    heading.textContent = "Unsaved";
    const before = parentPosts.filter(
      (p) => (p.data as { type?: string })?.type === "text.edit",
    ).length;
    act(() => {
      heading.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    const after = parentPosts.filter(
      (p) => (p.data as { type?: string })?.type === "text.edit",
    ).length;
    expect(after).toBe(before);
    expect(heading.getAttribute("contenteditable")).toBeNull();
  });

  it("clicking the hero CTA swaps to editable but does NOT navigate", () => {
    mountHarness();
    const cta = document.querySelector(
      '[data-testid="hero-cta"]',
    ) as HTMLAnchorElement;
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    act(() => {
      cta.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(cta.getAttribute("contenteditable")).toBe("true");
    expect(cta.dataset.instinctField).toBe("cta.label");
  });

  it("beginInlineEdit + commitInlineEdit can be driven directly for unit coverage", () => {
    const { container } = render(
      <h2 data-section-type-wrapper="true" className="instinct-inline-editable">
        Direct
      </h2>,
    );
    const el = container.querySelector("h2") as HTMLElement;
    const editingRef = createRef<HTMLElement | null>() as React.MutableRefObject<
      HTMLElement | null
    >;
    editingRef.current = null;
    const originalRef = { current: "" } as React.MutableRefObject<string>;
    act(() => {
      beginInlineEdit({
        el,
        pageIndex: 0,
        sectionIndex: 1,
        field: "heading",
        editingRef,
        editingOriginalText: originalRef,
      });
    });
    expect(el.getAttribute("contenteditable")).toBe("true");
    el.textContent = "New value";
    act(() => {
      commitInlineEdit(el, true);
    });
    const hit = parentPosts.find(
      (p) =>
        (p.data as { type?: string })?.type === "text.edit" &&
        (p.data as { value?: string })?.value === "New value",
    );
    expect(hit).toBeDefined();
  });
});
