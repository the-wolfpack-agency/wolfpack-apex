/**
 * @jest-environment jsdom
 */

/**
 * InlineEditOverlay — drag-to-reorder DOM contract (Path C Phase 2 · Q1).
 *
 * We mount RenderBrief + InlineEditOverlay directly (same approach as the
 * existing inline-edit overlay test — the full preview page suspends on
 * `use(params)` in jsdom). Stub `window.parent` to record postMessage
 * calls, then exercise the drag-and-drop flow and keyboard a11y.
 *
 * Locked-in contracts:
 *   - Handle renders per section, visibility controlled by hover (verified
 *     via class presence, not computed style — jsdom doesn't paint).
 *   - dragstart writes an Instinct-branded payload to the MIME-namespaced
 *     dataTransfer slot.
 *   - dragover adds the drop-indicator class based on cursor Y position.
 *   - drop on a different section posts `section.reorder` with correct
 *     from/to indices under the splice-semantics convention.
 *   - Drop on self → no message.
 *   - Keyboard ArrowUp / ArrowDown on a focused handle posts the same
 *     message shape (accessibility parity with mouse drag).
 */

import "@testing-library/jest-dom";
import { act, render, cleanup } from "@testing-library/react";
import { RenderBrief } from "@/components/sites/render-brief";
import { InlineEditOverlay } from "@/app/sites/[id]/preview/page";
import { INSTINCT_EDIT_ORIGIN } from "@/lib/preview-postmessage";
import type { SiteBrief } from "@/lib/sites-schema";

function brief(): SiteBrief {
  return {
    client: "acme",
    product: { name: "Acme", tagline: "Ship it" },
    pages: [
      {
        route: "/",
        sections: [
          {
            type: "hero",
            heading: "Welcome",
            body: "We help you ship.",
          },
          { type: "text", heading: "Features", body: "Lots of features." },
          { type: "callout", heading: "Get started", body: "It's easy." },
        ],
      },
    ],
  };
}

let parentPosts: Array<{ data: unknown; origin: string }> = [];

beforeEach(() => {
  parentPosts = [];
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

function mountHarness(b: SiteBrief = brief()) {
  return render(
    <div>
      <RenderBrief brief={b} page={0} />
      <InlineEditOverlay brief={b} pageIndex={0} onBriefPushed={() => {}} />
    </div>,
  );
}

/**
 * Force a non-zero bounding rect on every section so dragover's "upper
 * half vs lower half" math is deterministic. jsdom returns zeros by
 * default which collapses midpoint comparisons.
 */
function stubSectionRects(sections: NodeListOf<Element>) {
  sections.forEach((el) => {
    (el as HTMLElement).getBoundingClientRect = () =>
      ({
        top: 0,
        bottom: 100,
        left: 0,
        right: 1000,
        width: 1000,
        height: 100,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
  });
}

/**
 * jsdom's `DataTransfer` is minimal; craft a spec-shaped stand-in that
 * stores by MIME type and exposes `types`. Enough for our handler.
 */
function makeDataTransfer() {
  const store = new Map<string, string>();
  return {
    setData: (type: string, value: string) => store.set(type, value),
    getData: (type: string) => store.get(type) ?? "",
    get types() {
      return Array.from(store.keys());
    },
    effectAllowed: "move",
    dropEffect: "move",
  };
}

function fireDrag(
  el: Element,
  type: "dragstart" | "dragover" | "dragleave" | "drop" | "dragend",
  dataTransfer: ReturnType<typeof makeDataTransfer>,
  extras: { clientY?: number } = {},
) {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "dataTransfer", { value: dataTransfer, writable: false });
  if (extras.clientY !== undefined) {
    Object.defineProperty(ev, "clientY", {
      value: extras.clientY,
      writable: false,
    });
  }
  el.dispatchEvent(ev);
  return ev;
}

describe("reorder overlay — handle + drag contract", () => {
  it("renders one drag handle per section with the reorder handle class", () => {
    mountHarness();
    const handles = document.querySelectorAll(".instinct-section-reorder-handle");
    expect(handles.length).toBe(3);
    // Each handle references its section index so tests + e2e can target.
    expect(
      document.querySelector('[data-testid="section-reorder-handle-0"]'),
    ).toBeTruthy();
    expect(
      document.querySelector('[data-testid="section-reorder-handle-1"]'),
    ).toBeTruthy();
    expect(
      document.querySelector('[data-testid="section-reorder-handle-2"]'),
    ).toBeTruthy();
  });

  it("dragstart on section 0 writes instinct-branded payload to the MIME slot", () => {
    mountHarness();
    const handle = document.querySelector(
      '[data-testid="section-reorder-handle-0"]',
    ) as HTMLElement;
    const dt = makeDataTransfer();
    act(() => {
      fireDrag(handle, "dragstart", dt);
    });
    const raw = dt.getData("application/x-instinct-section");
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw);
    expect(parsed.origin).toBe(INSTINCT_EDIT_ORIGIN);
    expect(parsed.type).toBe("section.reorder");
    expect(parsed.pageIndex).toBe(0);
    expect(parsed.fromIndex).toBe(0);
  });

  it("dragover on a section adds a drop-indicator class based on cursor Y", () => {
    mountHarness();
    const sections = document.querySelectorAll("[data-section-type]");
    stubSectionRects(sections);
    const targetSection = sections[2] as HTMLElement;
    const dt = makeDataTransfer();
    dt.setData(
      "application/x-instinct-section",
      JSON.stringify({
        origin: INSTINCT_EDIT_ORIGIN,
        type: "section.reorder",
        pageIndex: 0,
        fromIndex: 0,
      }),
    );
    // Cursor in the top quarter (Y=10, rect height=100) → before.
    act(() => {
      fireDrag(targetSection, "dragover", dt, { clientY: 10 });
    });
    expect(
      targetSection.classList.contains("instinct-section-drop-before"),
    ).toBe(true);
    expect(
      targetSection.classList.contains("instinct-section-drop-after"),
    ).toBe(false);
    // Cursor in the bottom half (Y=80) → after.
    act(() => {
      fireDrag(targetSection, "dragover", dt, { clientY: 80 });
    });
    expect(
      targetSection.classList.contains("instinct-section-drop-after"),
    ).toBe(true);
    expect(
      targetSection.classList.contains("instinct-section-drop-before"),
    ).toBe(false);
  });

  it("drop on section 2 (bottom half) posts section.reorder fromIndex=0 toIndex=2", () => {
    mountHarness();
    const sections = document.querySelectorAll("[data-section-type]");
    stubSectionRects(sections);
    const handle = document.querySelector(
      '[data-testid="section-reorder-handle-0"]',
    ) as HTMLElement;
    const dt = makeDataTransfer();
    act(() => {
      fireDrag(handle, "dragstart", dt);
    });
    const targetSection = sections[2] as HTMLElement;
    // Drop in the bottom half (Y=80, height=100) → insert AFTER target.
    act(() => {
      fireDrag(targetSection, "dragover", dt, { clientY: 80 });
    });
    act(() => {
      fireDrag(targetSection, "drop", dt, { clientY: 80 });
    });
    const reorderPosts = parentPosts.filter(
      (p) => (p.data as { type?: string })?.type === "section.reorder",
    );
    expect(reorderPosts.length).toBe(1);
    const msg = reorderPosts[0].data as Record<string, number | string>;
    expect(msg.origin).toBe(INSTINCT_EDIT_ORIGIN);
    expect(msg.pageIndex).toBe(0);
    expect(msg.fromIndex).toBe(0);
    // from=0 < target=2, drop-after → splice semantics: remove at 0
    // shifts everything below down by one, so inserting at index 2
    // lands the section at the target's visual bottom edge.
    expect(msg.toIndex).toBe(2);
  });

  it("drop on the SAME section posts no message (no-op)", () => {
    mountHarness();
    const sections = document.querySelectorAll("[data-section-type]");
    stubSectionRects(sections);
    const handle = document.querySelector(
      '[data-testid="section-reorder-handle-1"]',
    ) as HTMLElement;
    const dt = makeDataTransfer();
    act(() => {
      fireDrag(handle, "dragstart", dt);
    });
    const selfSection = sections[1] as HTMLElement;
    act(() => {
      fireDrag(selfSection, "drop", dt, { clientY: 10 });
    });
    const reorderPosts = parentPosts.filter(
      (p) => (p.data as { type?: string })?.type === "section.reorder",
    );
    expect(reorderPosts.length).toBe(0);
  });

  it("ArrowUp on focused handle posts fromIndex → fromIndex - 1", () => {
    mountHarness();
    const handle = document.querySelector(
      '[data-testid="section-reorder-handle-1"]',
    ) as HTMLElement;
    act(() => {
      handle.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }),
      );
    });
    const reorderPosts = parentPosts.filter(
      (p) => (p.data as { type?: string })?.type === "section.reorder",
    );
    expect(reorderPosts.length).toBe(1);
    const msg = reorderPosts[0].data as Record<string, number>;
    expect(msg.fromIndex).toBe(1);
    expect(msg.toIndex).toBe(0);
  });

  it("ArrowDown on focused handle posts fromIndex → fromIndex + 1", () => {
    mountHarness();
    const handle = document.querySelector(
      '[data-testid="section-reorder-handle-1"]',
    ) as HTMLElement;
    act(() => {
      handle.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      );
    });
    const reorderPosts = parentPosts.filter(
      (p) => (p.data as { type?: string })?.type === "section.reorder",
    );
    expect(reorderPosts.length).toBe(1);
    const msg = reorderPosts[0].data as Record<string, number>;
    expect(msg.fromIndex).toBe(1);
    expect(msg.toIndex).toBe(2);
  });

  it("ArrowUp on the FIRST handle silently no-ops at the boundary", () => {
    mountHarness();
    const handle = document.querySelector(
      '[data-testid="section-reorder-handle-0"]',
    ) as HTMLElement;
    act(() => {
      handle.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }),
      );
    });
    const reorderPosts = parentPosts.filter(
      (p) => (p.data as { type?: string })?.type === "section.reorder",
    );
    expect(reorderPosts.length).toBe(0);
  });
});
