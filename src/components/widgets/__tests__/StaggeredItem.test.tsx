/**
 * @jest-environment jsdom
 *
 * StaggeredItem + useStaggeredReveal — reusable list-row reveal motion
 * shared by the 5 chat widgets (Calendar, EmailThread, TaskList,
 * GoodMorning, DmsInventory).
 *
 * What we assert here (the cross-cutting behavior — per-widget tests
 * cover the widget-specific wiring):
 *   1. Items render in the correct DOM order.
 *   2. Each item gets `wp-stagger-item` + an animation-delay derived
 *      from `index * staggerMs`.
 *   3. Children + click handlers + links work normally (no
 *      interception).
 *   4. The `useStaggeredReveal` hook fires exactly one
 *      `widget.items_revealed` analytics event per mount, with the
 *      expected metadata shape.
 *   5. itemCount=0 (empty-state widgets) does NOT fire the event.
 *   6. workflowId is forwarded when present and omitted when absent.
 *   7. Reduced-motion: the CSS handles snapping items to their final
 *      state — we assert the class is still applied (CSS overrides
 *      with !important; jsdom can't compute the cascaded value, so
 *      we verify the matchMedia branch is reachable and items still
 *      render in their final, queryable state).
 *   8. All items finish in the DOM (none stuck mid-animation /
 *      conditionally rendered).
 */

import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";

const mockFetch = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: unknown[]) => mockFetch(...a),
  jsonHeaders: () => ({ "Content-Type": "application/json" }),
}));

import {
  DEFAULT_STAGGER_MS,
  StaggeredItem,
  useStaggeredReveal,
} from "@/components/widgets/StaggeredItem";

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
});

/* Pure-presentation harness — a parent <ul> with N <StaggeredItem>
 * children. Used by the rendering tests. */
function ItemList({
  items,
  staggerMs,
  onClick,
}: {
  items: string[];
  staggerMs?: number;
  onClick?: (label: string) => void;
}) {
  return (
    <ul data-testid="parent">
      {items.map((label, i) => (
        <StaggeredItem
          key={label}
          index={i}
          staggerMs={staggerMs}
          data-testid={`item-${i}`}
          onClick={onClick ? () => onClick(label) : undefined}
        >
          {label}
        </StaggeredItem>
      ))}
    </ul>
  );
}

/* Hook harness — renders a div + fires useStaggeredReveal on mount. */
function HookHarness({
  widgetKind,
  itemCount,
  workflowId,
  staggerMs,
}: {
  widgetKind: string;
  itemCount: number;
  workflowId?: string;
  staggerMs?: number;
}) {
  useStaggeredReveal({ widgetKind, itemCount, workflowId, staggerMs });
  return <div data-testid="harness">ok</div>;
}

describe("StaggeredItem — render", () => {
  test("renders items in the correct DOM order", () => {
    render(<ItemList items={["alpha", "beta", "gamma"]} />);
    const parent = screen.getByTestId("parent");
    const labels = Array.from(parent.children).map((el) => el.textContent);
    expect(labels).toEqual(["alpha", "beta", "gamma"]);
  });

  test("each item is an <li> by default with wp-stagger-item class", () => {
    render(<ItemList items={["a", "b"]} />);
    const a = screen.getByTestId("item-0");
    expect(a.tagName).toBe("LI");
    expect(a.className).toContain("wp-stagger-item");
  });

  test("animation-delay is index * staggerMs (default 40ms)", () => {
    render(<ItemList items={["a", "b", "c", "d"]} />);
    /* index 0 → 0ms, 1 → 40ms, 2 → 80ms, 3 → 120ms with the default. */
    expect(screen.getByTestId("item-0").getAttribute("style")).toContain("0ms");
    expect(screen.getByTestId("item-1").getAttribute("style")).toContain("40ms");
    expect(screen.getByTestId("item-2").getAttribute("style")).toContain("80ms");
    expect(screen.getByTestId("item-3").getAttribute("style")).toContain("120ms");
  });

  test("custom staggerMs is honored", () => {
    render(<ItemList items={["a", "b"]} staggerMs={50} />);
    expect(screen.getByTestId("item-0").getAttribute("style")).toContain("0ms");
    expect(screen.getByTestId("item-1").getAttribute("style")).toContain("50ms");
  });

  test("DEFAULT_STAGGER_MS is within the requested 30-50ms range", () => {
    expect(DEFAULT_STAGGER_MS).toBeGreaterThanOrEqual(30);
    expect(DEFAULT_STAGGER_MS).toBeLessThanOrEqual(50);
  });

  test("data-stagger-index reflects the prop (introspectable for E2E)", () => {
    render(<ItemList items={["a", "b"]} />);
    expect(screen.getByTestId("item-0").getAttribute("data-stagger-index")).toBe("0");
    expect(screen.getByTestId("item-1").getAttribute("data-stagger-index")).toBe("1");
  });

  test("polymorphic `as` prop renders a different tag", () => {
    render(
      <div>
        <StaggeredItem as="div" index={0} data-testid="card">
          card
        </StaggeredItem>
      </div>,
    );
    const card = screen.getByTestId("card");
    expect(card.tagName).toBe("DIV");
    expect(card.className).toContain("wp-stagger-item");
  });

  test("caller's className merges with wp-stagger-item, doesn't replace it", () => {
    render(
      <StaggeredItem index={0} data-testid="x" className="custom-row text-xs">
        x
      </StaggeredItem>,
    );
    const el = screen.getByTestId("x");
    expect(el.className).toContain("wp-stagger-item");
    expect(el.className).toContain("custom-row");
    expect(el.className).toContain("text-xs");
  });

  test("onClick on the item still fires (animation does not block events)", () => {
    const onClick = jest.fn();
    render(<ItemList items={["a", "b"]} onClick={onClick} />);
    fireEvent.click(screen.getByTestId("item-1"));
    expect(onClick).toHaveBeenCalledWith("b");
  });

  test("child link is clickable (anchor wrapped inside item)", () => {
    const onLink = jest.fn();
    render(
      <StaggeredItem index={0} data-testid="row">
        <a href="#x" onClick={onLink}>
          link
        </a>
      </StaggeredItem>,
    );
    fireEvent.click(screen.getByText("link"));
    expect(onLink).toHaveBeenCalled();
  });

  test("negative index is clamped to 0 (no negative delay)", () => {
    render(
      <StaggeredItem index={-3} data-testid="weird">
        x
      </StaggeredItem>,
    );
    expect(screen.getByTestId("weird").getAttribute("style")).toContain("0ms");
  });

  test("all N items end up rendered in the DOM (none stuck mid-anim or conditional)", () => {
    render(<ItemList items={["a", "b", "c", "d", "e"]} />);
    for (let i = 0; i < 5; i++) {
      expect(screen.getByTestId(`item-${i}`)).toBeInTheDocument();
    }
  });
});

describe("useStaggeredReveal — analytics", () => {
  test("fires assistant.widget.items_revealed exactly once on mount", () => {
    render(<HookHarness widgetKind="email_thread" itemCount={3} />);
    const calls = mockFetch.mock.calls.filter((c) => c[0] === "/api/analytics");
    const revealCalls = calls.filter((c) =>
      String(c[1]?.body || "").includes("widget.items_revealed"),
    );
    expect(revealCalls).toHaveLength(1);
  });

  test("payload includes widget_kind, item_count, stagger_ms", () => {
    render(<HookHarness widgetKind="calendar" itemCount={4} />);
    const call = mockFetch.mock.calls.find((c) =>
      String(c[1]?.body || "").includes("widget.items_revealed"),
    );
    const body = JSON.parse(String(call?.[1]?.body || "{}"));
    expect(body.event).toBe("assistant.widget.items_revealed");
    expect(body.metadata.widget_kind).toBe("calendar");
    expect(body.metadata.item_count).toBe(4);
    expect(body.metadata.stagger_ms).toBe(DEFAULT_STAGGER_MS);
  });

  test("itemCount === 0 → no event (empty-state widgets don't reveal)", () => {
    render(<HookHarness widgetKind="task_list" itemCount={0} />);
    const revealCalls = mockFetch.mock.calls.filter((c) =>
      String(c[1]?.body || "").includes("widget.items_revealed"),
    );
    expect(revealCalls).toHaveLength(0);
  });

  test("workflowId is forwarded when present", () => {
    render(<HookHarness widgetKind="dms_inventory" itemCount={2} workflowId="wf-xyz" />);
    const call = mockFetch.mock.calls.find((c) =>
      String(c[1]?.body || "").includes("widget.items_revealed"),
    );
    expect(String(call?.[1]?.body)).toContain('"workflow_id":"wf-xyz"');
  });

  test("workflowId is omitted when not passed", () => {
    render(<HookHarness widgetKind="dms_inventory" itemCount={2} />);
    const call = mockFetch.mock.calls.find((c) =>
      String(c[1]?.body || "").includes("widget.items_revealed"),
    );
    expect(String(call?.[1]?.body)).not.toContain("workflow_id");
  });

  test("custom staggerMs lands in the payload", () => {
    render(<HookHarness widgetKind="good_morning" itemCount={5} staggerMs={35} />);
    const call = mockFetch.mock.calls.find((c) =>
      String(c[1]?.body || "").includes("widget.items_revealed"),
    );
    const body = JSON.parse(String(call?.[1]?.body || "{}"));
    expect(body.metadata.stagger_ms).toBe(35);
  });

  test("network failure does not throw (catch-and-swallow)", async () => {
    mockFetch.mockReset();
    mockFetch.mockRejectedValue(new Error("offline"));
    expect(() => {
      render(<HookHarness widgetKind="email_thread" itemCount={1} />);
    }).not.toThrow();
    /* Give the rejected promise a tick to settle. */
    await new Promise((r) => setTimeout(r, 0));
  });
});

describe("StaggeredItem — reduced motion", () => {
  /* The reduced-motion behavior is implemented in CSS
   * (`@media (prefers-reduced-motion: reduce)` snaps items to
   * opacity: 1; transform: none with !important). jsdom doesn't
   * apply CSS, so we verify two things:
   *   1. matchMedia('(prefers-reduced-motion: reduce)') is queryable
   *      (the JSDOM environment provides it via our mock — the
   *      classes the CSS targets are still applied by the component).
   *   2. Items still render with the `wp-stagger-item` class. The
   *      CSS rule takes over in real browsers. No JS branch needed.
   */
  test("with prefers-reduced-motion: items still render, class still applied (CSS handles snap)", () => {
    const origMatchMedia = window.matchMedia;
    (window as unknown as { matchMedia: typeof window.matchMedia }).matchMedia =
      ((q: string) => ({
        matches: q.includes("prefers-reduced-motion"),
        media: q,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        onchange: null,
        dispatchEvent: () => true,
      })) as unknown as typeof window.matchMedia;
    try {
      render(<ItemList items={["a", "b", "c"]} />);
      for (let i = 0; i < 3; i++) {
        const el = screen.getByTestId(`item-${i}`);
        expect(el).toBeInTheDocument();
        expect(el.className).toContain("wp-stagger-item");
      }
      /* Confirm the reduced-motion query reports true so the CSS
       * `@media` branch would fire in a real browser. */
      expect(window.matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
    } finally {
      (window as unknown as { matchMedia: typeof window.matchMedia }).matchMedia =
        origMatchMedia;
    }
  });
});
