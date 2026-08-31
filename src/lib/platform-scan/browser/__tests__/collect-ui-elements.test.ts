/**
 * @jest-environment jsdom
 *
 * Tests for the SELF-CONTAINED in-page collector, run directly in jsdom (the same
 * function Playwright serializes into page.evaluate at runtime). This proves the
 * collector produces UiElement objects that match the imported interface AND that
 * those objects feed the real classifyPage detectors correctly end to end - so a
 * green test here means the live runner will feed the server-side UX detectors the
 * right signals.
 */
import { collectUiElements } from "../capture";
import { classifyPage, type PageObservation, type UiElement } from "../classify";

/** Replace document.body with the given HTML and return it. */
function render(html: string): void {
  document.body.innerHTML = html;
}

/** Force a deterministic bounding box on a selector (jsdom returns all-zero). */
function stubBox(selector: string, w: number, h: number): void {
  const el = document.querySelector(selector) as HTMLElement;
  el.getBoundingClientRect = () =>
    ({ width: w, height: h, top: 0, left: 0, right: w, bottom: h, x: 0, y: 0, toJSON() {} }) as DOMRect;
}

function find(els: UiElement[], pred: (e: UiElement) => boolean): UiElement {
  const el = els.find(pred);
  if (!el) throw new Error("expected element not collected");
  return el;
}

it("icon-only button -> no accessibleName, interactive, has text undefined", () => {
  render(`<button id="b"><svg aria-hidden="true"></svg></button>`);
  const els = collectUiElements();
  const btn = find(els, (e) => e.tag === "button");
  expect(btn.interactive).toBe(true);
  expect(btn.accessibleName).toBeUndefined();
  expect(btn.textContent).toBeUndefined();
});

it("labeled button (aria-label) -> accessibleName set", () => {
  render(`<button aria-label="Close dialog"></button>`);
  const btn = find(collectUiElements(), (e) => e.tag === "button");
  expect(btn.accessibleName).toBe("Close dialog");
});

it("aria-labeledby resolves referenced text into accessibleName", () => {
  render(`<span id="lbl">Save changes</span><button aria-labeledby="lbl"></button>`);
  const btn = find(collectUiElements(), (e) => e.tag === "button");
  expect(btn.accessibleName).toBe("Save changes");
});

it("associated <label for> resolves into accessibleName for an input", () => {
  render(`<label for="email">Email address</label><input id="email" type="email" />`);
  const input = find(collectUiElements(), (e) => e.tag === "input");
  expect(input.accessibleName).toBe("Email address");
});

it("disabled control with title -> disabled + hasExplanation", () => {
  render(`<button disabled title="Complete the form first">Submit</button>`);
  const btn = find(collectUiElements(), (e) => e.tag === "button");
  expect(btn.disabled).toBe(true);
  expect(btn.hasExplanation).toBe(true);
});

it("aria-disabled=true and aria-describedby resolving -> disabled + hasExplanation", () => {
  render(`<p id="why">Needs admin</p><button aria-disabled="true" aria-describedby="why">Go</button>`);
  const btn = find(collectUiElements(), (e) => e.tag === "button");
  expect(btn.disabled).toBe(true);
  expect(btn.hasExplanation).toBe(true);
});

it("tiny vs normal box via stubbed getBoundingClientRect", () => {
  render(`<button id="tiny">x</button><button id="ok">y</button>`);
  stubBox("#tiny", 20, 20);
  stubBox("#ok", 48, 48);
  const els = collectUiElements();
  expect(find(els, (e) => e.textContent === "x").box).toEqual({ w: 20, h: 20 });
  expect(find(els, (e) => e.textContent === "y").box).toEqual({ w: 48, h: 48 });
});

it("element inside role=dialog -> inDialog true; the dialog -> isDialog true", () => {
  render(`<div role="dialog" aria-label="Settings"><button>OK</button></div>`);
  const els = collectUiElements();
  const dialog = find(els, (e) => e.isDialog === true);
  expect(dialog.role).toBe("dialog");
  expect(dialog.accessibleName).toBe("Settings");
  const inner = find(els, (e) => e.tag === "button");
  expect(inner.inDialog).toBe(true);
  expect(inner.isDialog).toBe(false);
});

it("skips display:none elements (not rendered)", () => {
  render(`<button style="display:none">Hidden</button><button>Shown</button>`);
  const els = collectUiElements();
  expect(els.find((e) => e.textContent === "Hidden")).toBeUndefined();
  expect(els.find((e) => e.textContent === "Shown")).toBeTruthy();
});

it("native <dialog> is collected as isDialog", () => {
  render(`<dialog open><button>Close</button></dialog>`);
  const dialog = find(collectUiElements(), (e) => e.tag === "dialog");
  expect(dialog.isDialog).toBe(true);
});

// --- end-to-end: collector output -> real classifyPage produces ux_gap findings ---

function obsWith(elements: UiElement[]): PageObservation {
  return {
    route: "/x",
    journey: "ux",
    status: 200,
    consoleErrors: [],
    cspViolations: [],
    failedRequests: [],
    renderedContent: true,
    durationMs: 10,
    elements,
  };
}

it("E2E: an icon-only button collected -> classifyPage fires iconOnlyControlNoName", () => {
  render(`<button><svg aria-hidden="true"></svg></button>`);
  const findings = classifyPage(obsWith(collectUiElements()));
  expect(
    findings.some((f) => f.title === "Interactive control has no accessible name"),
  ).toBe(true);
});

it("E2E: a disabled unexplained control -> classifyPage fires disabledControlNoExplanation", () => {
  render(`<button disabled>Submit</button>`);
  const findings = classifyPage(obsWith(collectUiElements()));
  expect(findings.some((f) => f.title === "Disabled control with no explanation")).toBe(true);
});

it("E2E: a tiny tap target -> classifyPage fires tinyTapTarget", () => {
  render(`<button>x</button>`);
  stubBox("button", 20, 20);
  const findings = classifyPage(obsWith(collectUiElements()));
  expect(findings.some((f) => f.title === "Tap target smaller than 44px")).toBe(true);
});

it("E2E: an unnamed div dialog -> classifyPage fires dialogNoAccessibleName", () => {
  render(`<div role="dialog"></div>`);
  const findings = classifyPage(obsWith(collectUiElements()));
  expect(
    findings.some((f) => f.title === "Modal/dialog missing role or accessible name"),
  ).toBe(true);
});

it("E2E: a healthy labeled, well-sized button yields NO ux_gap findings", () => {
  render(`<button aria-label="Save">Save</button>`);
  stubBox("button", 60, 48);
  const findings = classifyPage(obsWith(collectUiElements()));
  expect(findings.filter((f) => f.category === "ux_gap")).toHaveLength(0);
});
