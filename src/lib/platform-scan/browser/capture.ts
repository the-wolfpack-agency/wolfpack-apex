/**
 * Tier-1 READ-ONLY browser UX capture core.
 *
 * This is the PURE capture layer of the browser-journey platform scan. It drives
 * a headless browser over a target's pages and produces a RAW PageObservation per
 * page (the UI element tree + console/CSP/failed-request signals + render state).
 * It does NOT classify: the raw observations are POSTed to apex's ingest endpoint,
 * which runs the SAME pure classifyPage (the 4 UX detectors live and improve
 * server-side). The runner here stays "dumb" by design.
 *
 * Two best-practice constraints make this file safe and testable:
 *
 *  1. ZERO Playwright import. We program against a minimal `ScanPage` interface
 *     (only the methods we use), which the real Playwright Page satisfies
 *     structurally. So this core is unit-testable with a hand-rolled mock and is
 *     never pulled into the production runtime bundle (Playwright is dev/CI only).
 *     This is dependency inversion: the core owns the abstraction, the CLI
 *     supplies the concrete Page.
 *
 *  2. The in-page element collector (`collectUiElements`) is SELF-CONTAINED: it
 *     references no module-level symbol, so Playwright can serialize it into
 *     page.evaluate AND jsdom can call it directly in a unit test. It reads only
 *     document/window DOM APIs.
 *
 * Safety by construction: `installReadOnlyFloor` aborts every non-GET/HEAD request
 * before it leaves the browser, so a scan can never mutate the target client.
 */

import type { AxeViolation, PageObservation, UiElement } from "./classify";

/**
 * The minimal subset of a Playwright Page this core depends on. The real
 * Playwright `Page` is structurally compatible and is passed in by the CLI, so we
 * never import Playwright here. Kept intentionally small: only the methods the
 * capture path actually calls, so a test mock is trivial.
 */
export interface ScanRoute {
  /** True to let the request proceed unchanged. */
  continue(): Promise<void> | void;
  /** True to block the request entirely (the read-only floor uses this). */
  abort(): Promise<void> | void;
  /** The intercepted request. */
  request(): { method(): string };
}

export interface ScanConsoleMessage {
  type(): string;
  text(): string;
}

export interface ScanResponse {
  status(): number;
  url(): string;
}

export interface ScanGotoResult {
  status(): number;
  /**
   * Response headers, lowercased by the browser. A METHOD, not a property,
   * because that is what Playwright's Response actually exposes — a fake that
   * models it as a property will pass its own tests and fail in production.
   * Optional so existing callers and fakes that never needed it still satisfy
   * this interface.
   */
  headers?(): Record<string, string>;
}

export interface ScanPage {
  /** Register a request interceptor (used to install the read-only floor). */
  route(
    pattern: string,
    handler: (route: ScanRoute) => Promise<void> | void,
  ): Promise<void> | void;
  /** Subscribe to page events: "console" for errors, "response" for failures. */
  on(event: "console", handler: (msg: ScanConsoleMessage) => void): void;
  on(event: "response", handler: (res: ScanResponse) => void): void;
  on(event: string, handler: (arg: unknown) => void): void;
  /** Run an init script before navigation (used to trap CSP violations). */
  addInitScript(script: () => void): Promise<void> | void;
  /** Navigate to a URL. Resolves with the top-level document response (or null). */
  goto(url: string): Promise<ScanGotoResult | null>;
  /** Evaluate a self-contained function inside the page and return its result. */
  evaluate<R>(fn: () => R): Promise<R>;
}

/**
 * Install the deterministic READ-ONLY network floor on a page. Every request is
 * intercepted: GET and HEAD continue; everything else (POST/PUT/PATCH/DELETE/...)
 * is aborted before it can leave the browser. This is the safety guarantee that
 * makes a tier-1 scan safe to run against a client's production system: the scan
 * can never mutate state because no mutating request is ever allowed out.
 *
 * Method comparison is case-insensitive (Playwright reports upper-case, but we do
 * not depend on that).
 */
export async function installReadOnlyFloor(page: ScanPage): Promise<void> {
  await page.route("**/*", async (route) => {
    const method = route.request().method().toUpperCase();
    if (method === "GET" || method === "HEAD") {
      await route.continue();
    } else {
      await route.abort();
    }
  });
}

/**
 * SELF-CONTAINED in-page collector. Walks the rendered DOM and emits one
 * `UiElement` per interactive control and per dialog, matching the imported
 * `UiElement` interface EXACTLY.
 *
 * CRITICAL: this function must reference no symbol outside its own body so that
 * (a) Playwright can serialize it for page.evaluate, and (b) jsdom can call it
 * directly in a unit test. All helpers are declared inline.
 *
 * It reads only document/window APIs. Non-rendered elements (display:none) are
 * skipped so a detector never flags a hidden control.
 */
export function collectUiElements(): UiElement[] {
  // --- inline helpers (no external references) ---------------------------------

  const text = (node: Element | null): string =>
    (node?.textContent ?? "").replace(/\s+/g, " ").trim();

  const isRendered = (el: Element): boolean => {
    // jsdom returns an empty CSSStyleDeclaration for getComputedStyle; treat an
    // explicit display:none / visibility:hidden as not-rendered, otherwise keep.
    const w = el.ownerDocument?.defaultView;
    if (w && typeof w.getComputedStyle === "function") {
      const cs = w.getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") return false;
    }
    // Also honor an inline style="display:none" even when no computed style.
    const inline = (el as HTMLElement).style;
    if (inline && (inline.display === "none" || inline.visibility === "hidden")) {
      return false;
    }
    return true;
  };

  const accessibleName = (el: Element): string => {
    // 1. aria-label wins.
    const label = el.getAttribute("aria-label");
    if (label && label.trim()) return label.trim();
    // 2. aria-labeledby: concatenate the referenced elements' text.
    const labeledby = el.getAttribute("aria-labeledby");
    if (labeledby) {
      const parts: string[] = [];
      for (const id of labeledby.split(/\s+/)) {
        const ref = el.ownerDocument.getElementById(id);
        if (ref) parts.push(text(ref));
      }
      const joined = parts.filter(Boolean).join(" ").trim();
      if (joined) return joined;
    }
    // 3. associated <label>: explicit for=, wrapping label, or aria via id.
    const id = el.getAttribute("id");
    if (id) {
      // Escape backslashes BEFORE quotes: escaping only quotes leaves a
      // trailing "\" in the id free to escape our own closing quote and break
      // out of the selector (CodeQL: js/incomplete-sanitization). The id comes
      // from the scanned page, which is untrusted input.
      const escapedId = id.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      const forLabel = el.ownerDocument.querySelector(
        'label[for="' + escapedId + '"]',
      );
      if (forLabel) {
        const t = text(forLabel);
        if (t) return t;
      }
    }
    const wrappingLabel = el.closest("label");
    if (wrappingLabel) {
      const t = text(wrappingLabel);
      if (t) return t;
    }
    // 4. alt (images / inputs) then title.
    const alt = el.getAttribute("alt");
    if (alt && alt.trim()) return alt.trim();
    const title = el.getAttribute("title");
    if (title && title.trim()) return title.trim();
    return "";
  };

  const hasExplanation = (el: Element): boolean => {
    const title = el.getAttribute("title");
    if (title && title.trim()) return true;
    const describedby = el.getAttribute("aria-describedby");
    if (describedby) {
      for (const refId of describedby.split(/\s+/)) {
        if (el.ownerDocument.getElementById(refId)) return true;
      }
    }
    return false;
  };

  const isDisabled = (el: Element): boolean => {
    if (el.hasAttribute("disabled")) return true;
    if (el.getAttribute("aria-disabled") === "true") return true;
    return false;
  };

  const box = (el: Element): { w: number; h: number } | undefined => {
    if (typeof el.getBoundingClientRect !== "function") return undefined;
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  };

  const dialogRoles = ["dialog", "alertdialog"];

  const isDialogEl = (el: Element): boolean => {
    if (el.tagName.toLowerCase() === "dialog") return true;
    const role = el.getAttribute("role");
    return !!role && dialogRoles.indexOf(role) !== -1;
  };

  const inDialog = (el: Element): boolean => {
    // Closest ancestor (excluding self) that is a dialog.
    let p: Element | null = el.parentElement;
    while (p) {
      if (isDialogEl(p)) return true;
      p = p.parentElement;
    }
    return false;
  };

  // --- selection ---------------------------------------------------------------

  const INTERACTIVE_SELECTOR = [
    "button",
    "a[href]",
    '[role="button"]',
    '[role="link"]',
    '[role="menuitem"]',
    '[role="tab"]',
    "input",
    "select",
    "textarea",
  ].join(",");

  const DIALOG_SELECTOR = ['[role="dialog"]', '[role="alertdialog"]', "dialog"].join(",");

  const seen = new Set<Element>();
  const out: UiElement[] = [];

  const toElement = (el: Element, opts: { isDialog: boolean }): UiElement | null => {
    if (!isRendered(el)) return null;
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role") ?? undefined;
    const name = accessibleName(el);
    const elBox = box(el);
    return {
      tag,
      role,
      accessibleName: name || undefined,
      interactive: !opts.isDialog,
      disabled: isDisabled(el),
      hasExplanation: hasExplanation(el),
      box: elBox,
      inDialog: opts.isDialog ? false : inDialog(el),
      isDialog: opts.isDialog,
      textContent: text(el) || undefined,
    };
  };

  const dialogs = document.querySelectorAll(DIALOG_SELECTOR);
  for (let i = 0; i < dialogs.length; i++) {
    const el = dialogs[i];
    if (seen.has(el)) continue;
    seen.add(el);
    const ui = toElement(el, { isDialog: true });
    if (ui) out.push(ui);
  }

  const controls = document.querySelectorAll(INTERACTIVE_SELECTOR);
  for (let i = 0; i < controls.length; i++) {
    const el = controls[i];
    if (seen.has(el)) continue;
    seen.add(el);
    const ui = toElement(el, { isDialog: false });
    if (ui) out.push(ui);
  }

  return out;
}

/** Injectable seams for deterministic tests (clock) and the optional axe runner. */
export interface CaptureDeps {
  now?: () => number;
  /**
   * Optional accessibility runner. When provided, capturePage calls it with the
   * page and stores the result on observation.axeViolations. Injected (not
   * imported) so this core stays Playwright-free AND axe-free: the live CLI
   * supplies the concrete runner that injects axe-core into the page and calls
   * window.axe.run(). When absent, behavior is unchanged (axeViolations stays
   * undefined). Kept robust: a runner that throws is swallowed (no axe data
   * rather than a failed capture), mirroring the other best-effort evaluates.
   */
  runAxe?: (page: ScanPage) => Promise<AxeViolation[]>;
}

/**
 * Capture ONE page into a raw PageObservation.
 *
 * Attaches console-error, CSP-violation, and failed-request (>=400) listeners,
 * navigates to the route, awaits settle, then runs the self-contained collector
 * via page.evaluate to snapshot the element tree. Returns a PageObservation
 * (reusing the imported type) carrying ONLY raw signals; classification happens
 * server-side at ingest. The clock is injectable so durationMs is deterministic
 * in tests.
 *
 * Read-only by construction: this never issues a mutating request, and the caller
 * has already installed the read-only floor on the page.
 */
export async function capturePage(
  page: ScanPage,
  input: { route: string; journey: string },
  deps: CaptureDeps = {},
): Promise<PageObservation> {
  const now = deps.now ?? Date.now;

  const consoleErrors: string[] = [];
  const cspViolations: string[] = [];
  const failedRequests: { url: string; status: number }[] = [];

  page.on("console", (msg: ScanConsoleMessage) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("response", (res: ScanResponse) => {
    const status = res.status();
    if (status >= 400) failedRequests.push({ url: res.url(), status });
  });

  // Trap securitypolicyviolation events inside the page so we can read them back
  // after navigation. Self-contained: the init script references nothing outside.
  await page.addInitScript(() => {
    const w = window as unknown as { __cspViolations?: string[] };
    w.__cspViolations = w.__cspViolations || [];
    document.addEventListener("securitypolicyviolation", (e) => {
      const ev = e as SecurityPolicyViolationEvent;
      w.__cspViolations!.push(`${ev.violatedDirective} ${ev.blockedURI}`.trim());
    });
  });

  const started = now();
  let status: number | undefined;
  try {
    const resp = await page.goto(input.route);
    status = resp?.status();
  } catch {
    // A navigation failure leaves status undefined; downstream classifyPage
    // treats a blank, status-less page as a blank-render finding.
  }
  const durationMs = now() - started;

  let elements: UiElement[] = [];
  try {
    elements = await page.evaluate(collectUiElements);
  } catch {
    elements = [];
  }

  try {
    const csp = await page.evaluate(
      () => (window as unknown as { __cspViolations?: string[] }).__cspViolations ?? [],
    );
    for (const v of csp) cspViolations.push(v);
  } catch {
    // No CSP trap available (e.g. navigation never completed); leave empty.
  }

  let renderedContent = false;
  try {
    renderedContent = await page.evaluate(
      () => ((document.body && document.body.innerText) || "").trim().length > 0,
    );
  } catch {
    renderedContent = false;
  }

  // Optional accessibility pass. Only runs when a runAxe dep is injected; when
  // absent, axeViolations stays undefined and classifyPage behaves as before.
  // Best-effort: a runner failure leaves axeViolations undefined rather than
  // failing the whole capture (the page is still worth recording).
  let axeViolations: AxeViolation[] | undefined;
  if (deps.runAxe) {
    try {
      axeViolations = await deps.runAxe(page);
    } catch {
      axeViolations = undefined;
    }
  }

  return {
    route: input.route,
    journey: input.journey,
    status,
    consoleErrors,
    cspViolations,
    failedRequests,
    renderedContent,
    durationMs,
    elements,
    axeViolations,
  };
}
