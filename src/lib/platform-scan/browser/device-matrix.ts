/**
 * POST-DEPLOY MULTI-DEVICE UI VERIFICATION.
 *
 * The safety net for the ONE bug class that keeps reaching clients: a page that
 * looks fine on the developer's 1440px desktop but is broken on a phone —
 * content squished or buried below the fold, horizontal overflow (the page
 * scrolls sideways), or elements spilling past the viewport edge. Unit and
 * contract tests never catch these because they never lay out a real viewport.
 *
 * This module loads a target URL at several device widths and flags responsive /
 * layout regressions. It follows the same two best-practice constraints as the
 * rest of the browser scan (capture.ts / runner.ts / classify.ts):
 *
 *   1. The CORE detector `assessLayout` is a PURE function: a plain
 *      LayoutObservation in, DeviceFinding[] out. No Playwright, no browser, no
 *      network, no clock — so every layout rule is exhaustively unit-testable
 *      without launching anything. This is the correctness guarantee.
 *
 *   2. `runDeviceMatrix` is the thin live driver. It uses playwright-core's
 *      chromium (already a dependency), sets each viewport, optionally injects an
 *      auth stub + route-intercepts stubbed APIs so it can verify auth-gated
 *      pages WITHOUT real credentials, collects the raw LayoutObservation, and
 *      hands it to the pure `assessLayout`. It NEVER throws: chromium-unavailable
 *      (CI without browser binaries) yields a degraded result, not a crash.
 *
 * Findings use the SAME severity + category vocabulary as ScanFinding so a device
 * finding composes with the existing scan pipeline (map `device` onto a route and
 * it drops straight into the store / review UI via `deviceFindingToScanFinding`).
 */

import type { ScanCategory, ScanFinding, ScanSeverity } from "../types";

// ---------------------------------------------------------------------------
// Device matrix
// ---------------------------------------------------------------------------

/** One device profile: a human name + a CSS-pixel viewport. */
export interface Device {
  name: string;
  width: number;
  height: number;
}

/**
 * The default device matrix. Deliberately spans the three bands where responsive
 * layout breaks: a narrow phone (single-column, where horizontal overflow and
 * buried content bite), a tablet (the awkward middle breakpoint), and a wide
 * desktop (the width most code is written against, so the least likely to break —
 * it is the control). Widths are common real-device logical widths.
 */
export const DEVICES: readonly Device[] = [
  { name: "phone", width: 390, height: 844 },
  { name: "tablet", width: 820, height: 1180 },
  { name: "desktop", width: 1440, height: 900 },
] as const;

// ---------------------------------------------------------------------------
// Observation shape (the pure input to assessLayout)
// ---------------------------------------------------------------------------

/** A rendered element's bounding box in CSS pixels, distilled from
 *  getBoundingClientRect. Absent (`null`) when the element was not found. */
export interface ProbedRect {
  x: number;
  y: number;
  width: number;
  height: number;
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** One probed key element. `mustBeVisible` marks a selector the caller asserted
 *  MUST render with non-zero size (a headline, a primary CTA, the main content
 *  region); a missing or zero-size must-be-visible element is a high-severity
 *  buried-content finding. `rect` is null when the selector matched nothing. */
export interface ProbedElement {
  selector: string;
  rect: ProbedRect | null;
  text?: string;
  mustBeVisible?: boolean;
}

/**
 * The raw, browser-observed layout signals for ONE device load. Pure input to
 * assessLayout — no Playwright types leak in, so it is trivially constructable in
 * a test. Mirrors the signal set capture.ts collects (console / CSP / failed
 * requests) plus the layout-specific measurements (scroll width vs inner width,
 * per-element boxes).
 */
export interface LayoutObservation {
  /** The device profile name this observation was taken at. */
  device: string;
  /** Viewport width in CSS pixels (the device width). */
  viewportWidth: number;
  /** Viewport height in CSS pixels (the device height). */
  viewportHeight: number;
  /** document.scrollingElement.scrollWidth — the full laid-out content width.
   *  Greater than innerWidth means the page overflows horizontally (sideways
   *  scroll), the headline responsive bug. */
  documentScrollWidth: number;
  /** window.innerWidth — the visible viewport width. */
  innerWidth: number;
  /** Probed key elements (overflow + must-be-visible checks run over these). */
  probed: ProbedElement[];
  /** Console error strings captured during the load. */
  consoleErrors: string[];
  /** Content-Security-Policy violation strings captured during the load. */
  cspViolations: string[];
  /** In-page requests that returned >= 400. */
  failedRequests: { url: string; status: number }[];
  /** Text elements that clip their content (overflow hidden / ellipsis) with
   *  content wider than the box, so text is visibly cut off. Optional so older
   *  observations (and unit tests) that predate the check still construct. */
  clipped?: { label: string; contentWidth: number; boxWidth: number }[];
  /** Pairs of visible, non-positioned elements whose boxes significantly overlap
   *  (drawn on top of each other). Optional; empty/undefined means none found. */
  overlaps?: { a: string; b: string }[];
  /** Absolute document-top (px) of the primary content element (the first
   *  must-be-visible selector). null when no such selector was probed. Beyond one
   *  viewport height = content buried below the fold. */
  contentTopPx?: number | null;
}

// ---------------------------------------------------------------------------
// Finding shape
// ---------------------------------------------------------------------------

/**
 * One layout issue on one device. Intentionally shaped like ScanFinding (same
 * `severity` / `category` / `evidence` vocabulary) but keyed by `device` instead
 * of `route`, plus a stable `id` so the same regression on the same device
 * dedupes across runs. Use `deviceFindingToScanFinding` to fold it into the
 * shared store.
 */
export interface DeviceFinding {
  /** Stable, deterministic id: same issue on same device -> same id across runs. */
  id: string;
  /** Device profile name the issue was observed on. */
  device: string;
  severity: ScanSeverity;
  category: ScanCategory;
  title: string;
  detail: string;
  evidence: Record<string, string | number | boolean | null>;
}

/** Fold a DeviceFinding into the shared ScanFinding model so it lands in the same
 *  store / review UI as HTTP and browser-journey findings. The route is
 *  synthesized as `<url> [<device>]` so a reviewer sees which device broke. */
export function deviceFindingToScanFinding(
  finding: DeviceFinding,
  url: string,
): ScanFinding {
  return {
    route: `${url} [${finding.device}]`,
    severity: finding.severity,
    category: finding.category,
    title: finding.title,
    detail: finding.detail,
    evidence: { ...finding.evidence, device: finding.device, finding_id: finding.id },
  };
}

// ---------------------------------------------------------------------------
// assessLayout — THE PURE CORE
// ---------------------------------------------------------------------------

/** Sub-pixel tolerance so a fractional rounding difference (a 390.0 viewport vs a
 *  390.4 scrollWidth from a hairline border) never fires a false overflow. */
const OVERFLOW_TOLERANCE_PX = 1;
/** How many px an element's content must exceed its box before it counts as
 *  clipped/cut-off text (small tolerance for sub-pixel rounding). */
const CLIP_TOLERANCE_PX = 6;
/** Primary content whose top starts beyond this multiple of the viewport height
 *  is "below the fold": you scroll past a wall of chrome/nav before reaching it. */
const BURIED_TOP_FACTOR = 1.0;

/**
 * Assess ONE device's layout observation into zero or more findings. PURE: same
 * observation in, same findings out. No browser, no I/O.
 *
 * Rules (each maps onto the shared ScanSeverity vocabulary):
 *   - Horizontal overflow (scrollWidth > innerWidth + 1) ......... high  / bug
 *   - A probed element whose rect.right exceeds the viewport ..... high  / bug
 *   - A must-be-visible element that is missing or zero-size ..... high  / ux_gap
 *   - CSP violation(s) .......................................... high  / security
 *   - A failed request (>= 400): 5xx ............................ high  / bug
 *                                4xx ............................ medium / bug
 *   - Console error(s) .......................................... medium / bug
 *
 * A clean observation yields []. One observation can yield many findings.
 */
export function assessLayout(obs: LayoutObservation): DeviceFinding[] {
  const findings: DeviceFinding[] = [];
  const { device, viewportWidth } = obs;

  // 1. Horizontal overflow — the page scrolls sideways. The single most common
  //    "looks broken on mobile" symptom: a fixed-width element or an unwrapped
  //    row pushes the document wider than the viewport.
  if (obs.documentScrollWidth > obs.innerWidth + OVERFLOW_TOLERANCE_PX) {
    const overflowPx = obs.documentScrollWidth - obs.innerWidth;
    findings.push({
      id: `device-matrix:${device}:horizontal-overflow`,
      device,
      severity: "high",
      category: "bug",
      title: "Horizontal overflow (page scrolls sideways)",
      detail: `On ${device} (${viewportWidth}px) the page content is ${obs.documentScrollWidth}px wide but the viewport is only ${obs.innerWidth}px — the page overflows horizontally by ${overflowPx}px, forcing a sideways scroll.`,
      evidence: {
        device,
        scrollWidth: obs.documentScrollWidth,
        innerWidth: obs.innerWidth,
        overflowPx,
      },
    });
  }

  // 2 + 3. Per-probed-element checks.
  for (const el of obs.probed) {
    const missing = el.rect === null;
    const zeroSize = el.rect !== null && (el.rect.width <= 0 || el.rect.height <= 0);

    // 3. A must-be-visible element that is missing or has zero size = buried /
    //    absent key content (the "content buried on mobile" bug class).
    if (el.mustBeVisible && (missing || zeroSize)) {
      findings.push({
        id: `device-matrix:${device}:hidden-required:${el.selector}`,
        device,
        severity: "high",
        category: "ux_gap",
        title: "Required element missing or zero-size",
        detail: missing
          ? `On ${device} (${viewportWidth}px) the required element "${el.selector}" was not found in the page — key content is missing on this device.`
          : `On ${device} (${viewportWidth}px) the required element "${el.selector}" rendered at ${el.rect!.width}x${el.rect!.height}px (zero-size) — key content is collapsed / hidden on this device.`,
        evidence: {
          device,
          selector: el.selector,
          missing,
          width: el.rect?.width ?? null,
          height: el.rect?.height ?? null,
        },
      });
      // A missing/zero-size element cannot also overflow; skip the edge check.
      continue;
    }

    // 2. Any probed element spilling past the right viewport edge — an element
    //    that overlaps / is clipped off-screen even if the document itself did
    //    not report a wider scrollWidth (e.g. an absolutely-positioned overlay).
    if (el.rect !== null && el.rect.right > viewportWidth + OVERFLOW_TOLERANCE_PX) {
      const overflowPx = Math.round(el.rect.right - viewportWidth);
      findings.push({
        id: `device-matrix:${device}:element-overflow:${el.selector}`,
        device,
        severity: "high",
        category: "bug",
        title: "Element overflows the viewport edge",
        detail: `On ${device} (${viewportWidth}px) the element "${el.selector}" extends to ${Math.round(el.rect.right)}px, ${overflowPx}px past the ${viewportWidth}px viewport edge — it is clipped or overlapping off-screen.`,
        evidence: {
          device,
          selector: el.selector,
          right: Math.round(el.rect.right),
          viewportWidth,
          overflowPx,
        },
      });
    }
  }

  // 3b. Cut-off text — an element that clips its content (overflow hidden /
  //     ellipsis) while its content is wider than the box, so text is visibly
  //     truncated. The "the label/title is cut off on mobile" class. Medium:
  //     lossy but not blank.
  for (const c of obs.clipped ?? []) {
    findings.push({
      id: `device-matrix:${device}:clipped:${c.label}`,
      device,
      severity: "medium",
      category: "ux_gap",
      title: "Text is cut off",
      detail: `On ${device} (${viewportWidth}px) "${c.label}" is truncated — its content is ${c.contentWidth}px wide but the box is only ${c.boxWidth}px, so text is cut off.`,
      evidence: { device, label: c.label, contentWidth: c.contentWidth, boxWidth: c.boxWidth },
    });
  }

  // 3c. Overlapping elements — two visible, non-positioned text/interactive boxes
  //     that significantly intersect, i.e. content drawn on top of content. The
  //     "the status pill sits on the title" / collided-card class.
  for (const o of obs.overlaps ?? []) {
    findings.push({
      id: `device-matrix:${device}:overlap:${o.a}|${o.b}`,
      device,
      severity: "high",
      category: "bug",
      title: "Elements overlap",
      detail: `On ${device} (${viewportWidth}px) "${o.a}" and "${o.b}" overlap — they are drawn on top of each other, so the content collides.`,
      evidence: { device, a: o.a, b: o.b },
    });
  }

  // 3d. Primary content buried below the fold — the main content starts beyond
  //     one viewport height, so the user scrolls past a wall of nav/chrome before
  //     reaching anything (the wiki-nav-buried class on mobile).
  if (obs.contentTopPx != null && obs.contentTopPx > obs.viewportHeight * BURIED_TOP_FACTOR) {
    findings.push({
      id: `device-matrix:${device}:buried-content`,
      device,
      severity: "high",
      category: "ux_gap",
      title: "Primary content buried below the fold",
      detail: `On ${device} (${viewportWidth}px) the main content starts ${obs.contentTopPx}px down, past the ${obs.viewportHeight}px viewport — the user must scroll before reaching any content.`,
      evidence: { device, contentTopPx: obs.contentTopPx, viewportHeight: obs.viewportHeight },
    });
  }

  // 4. CSP violations — a hard signal the page is shipping resources the policy
  //    blocks, often the cause of a blank / half-rendered page.
  if (obs.cspViolations.length > 0) {
    findings.push({
      id: `device-matrix:${device}:csp`,
      device,
      severity: "high",
      category: "security",
      title: "CSP violation on page",
      detail: `On ${device} (${viewportWidth}px) the page triggered ${obs.cspViolations.length} Content-Security-Policy violation(s).`,
      evidence: {
        device,
        count: obs.cspViolations.length,
        sample: obs.cspViolations[0] ?? null,
      },
    });
  }

  // 5. Failed requests — a >= 400 in-page request. 5xx is a hard server/API
  //    failure (high); 4xx is a client/auth failure that can leave the page
  //    hollow (medium). One finding per failed request so severity is exact.
  for (const req of obs.failedRequests) {
    if (req.status < 400) continue;
    const severity: ScanSeverity = req.status >= 500 ? "high" : "medium";
    findings.push({
      id: `device-matrix:${device}:failed-request:${req.status}:${req.url}`,
      device,
      severity,
      category: "bug",
      title: `Failed request (${req.status})`,
      detail: `On ${device} (${viewportWidth}px) an in-page request to ${req.url} returned ${req.status} — the page can render but be functionally empty.`,
      evidence: { device, url: req.url, status: req.status },
    });
  }

  // 6. Console errors — the weakest signal, but a non-empty error stream on a
  //    post-deploy load is a regression smell worth triaging.
  if (obs.consoleErrors.length > 0) {
    findings.push({
      id: `device-matrix:${device}:console-errors`,
      device,
      severity: "medium",
      category: "bug",
      title: "Console errors on page",
      detail: `On ${device} (${viewportWidth}px) the page logged ${obs.consoleErrors.length} console error(s).`,
      evidence: {
        device,
        count: obs.consoleErrors.length,
        sample: obs.consoleErrors[0] ?? null,
      },
    });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// runDeviceMatrix — the live driver (chromium)
// ---------------------------------------------------------------------------

/** Auth stub injected into the page before any script runs, so an auth-gated page
 *  can be verified WITHOUT real credentials. Mirrors how the app stores its
 *  session client-side (a bearer token + user object in localStorage). */
export interface DeviceMatrixSession {
  /** Access token written to localStorage under `token` (matches client-auth). */
  token?: string;
  /** User object written to localStorage under `user` (JSON-stringified). */
  user?: Record<string, unknown>;
  /** Arbitrary extra localStorage key/values to seed. */
  localStorage?: Record<string, string>;
}

export interface RunDeviceMatrixOptions {
  /** Device matrix to run. Defaults to DEVICES. */
  devices?: readonly Device[];
  /** Selectors that MUST render with non-zero size on every device. */
  mustBeVisible?: string[];
  /** Extra selectors to probe for edge-overflow (not required, just measured). */
  probeSelectors?: string[];
  /** Auth stub injected via addInitScript before navigation. */
  session?: DeviceMatrixSession;
  /** urlSubstring -> JSON body. Any in-page request whose URL contains the key is
   *  fulfilled with the body (200 application/json), so auth-gated data loads
   *  succeed without a real backend. */
  stubApi?: Record<string, unknown>;
  /** Per-navigation timeout (ms). Default 20000. */
  timeoutMs?: number;
  /** Actor the analytics event is attributed to. Defaults to a system actor. */
  actor?: { id: string; role: string };
  /** Injected chromium (tests / a caller that already launched one). Defaults to
   *  a dynamic import of playwright-core. When it (or launch) is unavailable, the
   *  run degrades instead of throwing. */
  chromium?: DeviceMatrixChromium;
  /** Injected analytics sink (tests). Defaults to the real trackEvent, lazily
   *  imported so this module's static import graph stays browser/db-free. */
  trackEvent?: DeviceMatrixTrackEvent;
}

/** The minimal chromium surface runDeviceMatrix needs — playwright-core's
 *  `chromium` satisfies it structurally. */
export interface DeviceMatrixChromium {
  launch(options?: { headless?: boolean }): Promise<DeviceMatrixBrowser>;
}
export interface DeviceMatrixBrowser {
  newContext(options?: {
    viewport?: { width: number; height: number };
  }): Promise<DeviceMatrixContext>;
  close(): Promise<void>;
}
export interface DeviceMatrixContext {
  addInitScript(script: string): Promise<void>;
  route(
    pattern: string,
    handler: (route: DeviceMatrixRoute) => Promise<void> | void,
  ): Promise<void>;
  newPage(): Promise<DeviceMatrixPage>;
  close(): Promise<void>;
}
export interface DeviceMatrixRoute {
  request(): { url(): string; method(): string };
  fulfill(response: {
    status?: number;
    contentType?: string;
    body?: string;
  }): Promise<void>;
  continue(): Promise<void>;
  abort(): Promise<void>;
}
export interface DeviceMatrixPage {
  on(event: "console", handler: (msg: { type(): string; text(): string }) => void): void;
  on(event: "response", handler: (res: { status(): number; url(): string }) => void): void;
  addInitScript(script: string): Promise<void>;
  goto(
    url: string,
    options?: { waitUntil?: string; timeout?: number },
  ): Promise<unknown>;
  waitForLoadState(state: string): Promise<void>;
  evaluate<R>(fn: string, arg?: unknown): Promise<R>;
}

export type DeviceMatrixTrackEvent = (
  event: string,
  userId: string,
  userRole: string,
  metadata: Record<string, string | number | boolean>,
) => void;

export interface DeviceMatrixResult {
  url: string;
  byDevice: Record<string, DeviceFinding[]>;
  allFindings: DeviceFinding[];
  /** True when the run could not launch a browser and returned no measurements.
   *  A degraded result is NEVER silently treated as a clean pass. */
  degraded: boolean;
  /** Why the run degraded, when it did. */
  degradedReason?: string;
}

/** The analytics event this feature emits. Kept in one place so the string
 *  matches the InstinctEventType union exactly. Prefix `platform.` matches the
 *  existing platform-scan event family (platform.scan_completed, etc.). */
export const DEVICE_MATRIX_EVENT = "platform.device_matrix_run";

const SYSTEM_ACTOR = { id: "system.device_matrix", role: "system" } as const;

/**
 * Run the multi-device UI verification against a URL. For each device: launch a
 * viewport-sized context, inject the optional auth stub + API stubs, navigate,
 * collect the raw LayoutObservation, and run the pure `assessLayout`. Returns the
 * per-device + flattened findings. NEVER throws — a chromium-unavailable
 * environment (CI without browser binaries) returns a degraded result.
 */
export async function runDeviceMatrix(
  url: string,
  opts: RunDeviceMatrixOptions = {},
): Promise<DeviceMatrixResult> {
  const devices = opts.devices ?? DEVICES;
  const timeoutMs = opts.timeoutMs ?? 20000;

  const chromium = await resolveChromium(opts.chromium);
  if (!chromium) {
    return {
      url,
      byDevice: {},
      allFindings: [],
      degraded: true,
      degradedReason: "chromium unavailable (playwright-core not installed or failed to load)",
    };
  }

  let browser: DeviceMatrixBrowser | undefined;
  const byDevice: Record<string, DeviceFinding[]> = {};
  const allFindings: DeviceFinding[] = [];

  try {
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    return {
      url,
      byDevice: {},
      allFindings: [],
      degraded: true,
      degradedReason: `chromium launch failed: ${(err as Error).message}`,
    };
  }

  try {
    for (const device of devices) {
      try {
        const findings = await runOneDevice(browser, url, device, opts, timeoutMs);
        byDevice[device.name] = findings;
        allFindings.push(...findings);
      } catch (err) {
        // One device failing must not abort the matrix. Record the failure as a
        // finding so a crashed device is visible, never silently dropped.
        const finding: DeviceFinding = {
          id: `device-matrix:${device.name}:load-error`,
          device: device.name,
          severity: "high",
          category: "bug",
          title: "Device load failed",
          detail: `Could not load the page on ${device.name} (${device.width}px): ${(err as Error).message}`,
          evidence: { device: device.name, error: (err as Error).message },
        };
        byDevice[device.name] = [finding];
        allFindings.push(finding);
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  emitEvent(url, devices.length, allFindings, opts);

  return { url, byDevice, allFindings, degraded: false };
}

/** Resolve the chromium driver: use the injected one, else dynamically import
 *  playwright-core. Returns null (never throws) when unavailable. */
async function resolveChromium(
  injected?: DeviceMatrixChromium,
): Promise<DeviceMatrixChromium | null> {
  if (injected) return injected;
  try {
    const mod = (await import("playwright-core")) as unknown as {
      chromium?: DeviceMatrixChromium;
    };
    return mod.chromium ?? null;
  } catch {
    return null;
  }
}

/** Load + measure one device, returning its findings. */
async function runOneDevice(
  browser: DeviceMatrixBrowser,
  url: string,
  device: Device,
  opts: RunDeviceMatrixOptions,
  timeoutMs: number,
): Promise<DeviceFinding[]> {
  const context = await browser.newContext({
    viewport: { width: device.width, height: device.height },
  });
  try {
    // (a) Auth stub — seed localStorage BEFORE any page script runs so an
    //     auth-gated page sees an established session.
    if (opts.session) {
      await context.addInitScript(buildSessionInitScript(opts.session));
    }

    // (b) API stubs — fulfill matching requests with canned JSON so auth-gated
    //     data loads succeed without a real backend.
    if (opts.stubApi && Object.keys(opts.stubApi).length > 0) {
      const stubs = opts.stubApi;
      await context.route("**/*", async (route) => {
        const reqUrl = route.request().url();
        for (const key of Object.keys(stubs)) {
          if (reqUrl.includes(key)) {
            await route.fulfill({
              status: 200,
              contentType: "application/json",
              body: JSON.stringify(stubs[key]),
            });
            return;
          }
        }
        await route.continue();
      });
    }

    const page = await context.newPage();

    const consoleErrors: string[] = [];
    const failedRequests: { url: string; status: number }[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("response", (res) => {
      const status = res.status();
      if (status >= 400) failedRequests.push({ url: res.url(), status });
    });

    // Trap CSP violations inside the page (same technique as capture.ts).
    await page.addInitScript(CSP_TRAP_SCRIPT);

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.waitForLoadState("networkidle").catch(() => {});

    const selectors = buildProbeList(opts);
    const measured = await measureLayoutDom(page, selectors);

    const observation: LayoutObservation = {
      device: device.name,
      viewportWidth: device.width,
      viewportHeight: device.height,
      documentScrollWidth: measured.documentScrollWidth,
      innerWidth: measured.innerWidth,
      probed: measured.probed,
      consoleErrors,
      cspViolations: measured.cspViolations,
      failedRequests,
      clipped: measured.clipped,
      overlaps: measured.overlaps,
      contentTopPx: measured.contentTopPx,
    };

    return assessLayout(observation);
  } finally {
    await context.close().catch(() => {});
  }
}

/** Build the list of selectors to probe, tagging each with mustBeVisible. */
function buildProbeList(
  opts: RunDeviceMatrixOptions,
): { selector: string; mustBeVisible: boolean }[] {
  const out: { selector: string; mustBeVisible: boolean }[] = [];
  const seen = new Set<string>();
  for (const s of opts.mustBeVisible ?? []) {
    if (seen.has(s)) continue;
    seen.add(s);
    out.push({ selector: s, mustBeVisible: true });
  }
  for (const s of opts.probeSelectors ?? []) {
    if (seen.has(s)) continue;
    seen.add(s);
    out.push({ selector: s, mustBeVisible: false });
  }
  return out;
}

/** Build the addInitScript body that seeds the session into localStorage. Passed
 *  as a string so it needs no closure serialization. */
function buildSessionInitScript(session: DeviceMatrixSession): string {
  const entries: Record<string, string> = { ...(session.localStorage ?? {}) };
  if (session.token) entries.token = session.token;
  if (session.user) entries.user = JSON.stringify(session.user);
  const json = JSON.stringify(entries);
  return `(() => { try { const e = ${json}; for (const k in e) { window.localStorage.setItem(k, e[k]); } } catch (_) {} })();`;
}

/** In-page CSP-violation trap, self-contained (same idea as capture.ts). */
const CSP_TRAP_SCRIPT = `(() => {
  const w = window;
  w.__deviceMatrixCsp = w.__deviceMatrixCsp || [];
  document.addEventListener("securitypolicyviolation", (e) => {
    w.__deviceMatrixCsp.push((e.violatedDirective + " " + e.blockedURI).trim());
  });
})();`;

/** In-page measurement collector. Self-contained (references nothing outside its
 *  own body) so playwright can serialize it. Takes the tagged selector list and
 *  returns scroll/inner widths, per-element rects, and trapped CSP violations. */
const MEASURE_SCRIPT = `(selectors) => {
  const doc = document.scrollingElement || document.documentElement;
  const probed = selectors.map((s) => {
    let el = null;
    try { el = document.querySelector(s.selector); } catch (_) { el = null; }
    if (!el) return { selector: s.selector, rect: null, mustBeVisible: s.mustBeVisible };
    const r = el.getBoundingClientRect();
    return {
      selector: s.selector,
      mustBeVisible: s.mustBeVisible,
      text: (el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 120),
      rect: {
        x: r.x, y: r.y, width: r.width, height: r.height,
        top: r.top, right: r.right, bottom: r.bottom, left: r.left,
      },
    };
  });
  const norm = (el) => (el.tagName.toLowerCase() + " " + (el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 32)).trim();
  // Buried: absolute document-top of the first must-be-visible element.
  var contentTopPx = null;
  for (const s of selectors) {
    if (!s.mustBeVisible) continue;
    let el = null;
    try { el = document.querySelector(s.selector); } catch (_) { el = null; }
    if (el) { contentTopPx = Math.round(el.getBoundingClientRect().top + window.scrollY); break; }
  }
  // Cut-off text: elements that clip their content (overflow hidden / ellipsis)
  // while the content is wider than the box.
  const clipped = [];
  const textEls = Array.prototype.slice.call(document.querySelectorAll("a,button,span,strong,em,h1,h2,h3,h4,h5,p,li,td,th,label,div")).slice(0, 800);
  for (let i = 0; i < textEls.length && clipped.length < 12; i++) {
    const el = textEls[i];
    if (!(el.textContent || "").trim()) continue;
    const cs = getComputedStyle(el);
    if (cs.overflow !== "hidden" && cs.overflowX !== "hidden" && cs.textOverflow !== "ellipsis") continue;
    if (el.scrollWidth > el.clientWidth + ${CLIP_TOLERANCE_PX} && el.clientWidth > 24) {
      clipped.push({ label: norm(el), contentWidth: el.scrollWidth, boxWidth: el.clientWidth });
    }
  }
  // Overlap: visible, non-positioned text/interactive boxes that significantly
  // intersect (drawn on top of each other). Bounded to keep the O(n^2) cheap.
  const overlaps = [];
  const boxes = [];
  const oEls = Array.prototype.slice.call(document.querySelectorAll("a,button,span,strong,h1,h2,h3,h4,input,select,label")).slice(0, 160);
  for (const el of oEls) {
    const cs = getComputedStyle(el);
    if (cs.position === "absolute" || cs.position === "fixed" || cs.display === "none" || cs.visibility === "hidden") continue;
    if (!(el.textContent || "").trim() && el.tagName !== "INPUT" && el.tagName !== "SELECT") continue;
    const r = el.getBoundingClientRect();
    if (r.width > 4 && r.height > 4 && r.width < 2000 && r.height < 2000) boxes.push({ el: el, r: r });
  }
  outer: for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      const ix = Math.max(0, Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left));
      const iy = Math.max(0, Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top));
      const area = ix * iy;
      if (area <= 0) continue;
      const minArea = Math.min(a.r.width * a.r.height, b.r.width * b.r.height);
      if (area > minArea * 0.4) { overlaps.push({ a: norm(a.el), b: norm(b.el) }); if (overlaps.length >= 10) break outer; }
    }
  }
  const w = window;
  return {
    documentScrollWidth: doc ? doc.scrollWidth : 0,
    innerWidth: window.innerWidth,
    probed: probed,
    cspViolations: (w.__deviceMatrixCsp || []).slice(),
    clipped: clipped,
    overlaps: overlaps,
    contentTopPx: contentTopPx,
  };
}`;

/** The DOM half of a LayoutObservation (everything measurable inside the page,
 *  before the caller adds device + console/network context). */
export interface DomMeasure {
  documentScrollWidth: number;
  innerWidth: number;
  probed: ProbedElement[];
  cspViolations: string[];
  clipped: { label: string; contentWidth: number; boxWidth: number }[];
  overlaps: { a: string; b: string }[];
  contentTopPx: number | null;
}

/**
 * Run the in-page layout measure over `selectors` on an ALREADY-NAVIGATED page,
 * returning the DOM half of a LayoutObservation. Exported so an authenticated
 * post-deploy sweep (a real signed-in Playwright page) reuses the EXACT same
 * measurement + `assessLayout` that runDeviceMatrix uses, instead of stubbing a
 * session. The string is self-invoked with inlined selectors because
 * page.evaluate(stringFn, arg) evaluates the string as an expression and drops
 * arg (the bug that made every measure return undefined before).
 */
export async function measureLayoutDom(
  page: { evaluate: (script: string) => Promise<unknown> },
  selectors: { selector: string; mustBeVisible?: boolean }[],
): Promise<DomMeasure> {
  return (await page.evaluate(
    `(${MEASURE_SCRIPT})(${JSON.stringify(selectors)})`,
  )) as DomMeasure;
}

/** Emit the analytics event. Best-effort + no-op-safe: the injected/real
 *  trackEvent already no-ops without a DATABASE_URL, and any throw is swallowed
 *  so analytics never breaks a verification run. */
function emitEvent(
  url: string,
  deviceCount: number,
  allFindings: DeviceFinding[],
  opts: RunDeviceMatrixOptions,
): void {
  const actor = opts.actor ?? SYSTEM_ACTOR;
  const highCount = allFindings.filter((f) => f.severity === "high").length;
  const metadata = { url, deviceCount, highCount };

  const track = opts.trackEvent;
  if (track) {
    try {
      track(DEVICE_MATRIX_EVENT, actor.id, actor.role, metadata);
    } catch {
      /* analytics is best-effort */
    }
    return;
  }

  // Lazy import keeps analytics (and its db/qdrant graph) out of this module's
  // static imports, so assessLayout unit-tests without pulling any of it in.
  import("@/lib/analytics")
    .then((mod) => {
      try {
        mod.trackEvent(
          DEVICE_MATRIX_EVENT as Parameters<typeof mod.trackEvent>[0],
          actor.id,
          actor.role,
          metadata,
        );
      } catch {
        /* best-effort */
      }
    })
    .catch(() => {
      /* analytics unavailable in this environment */
    });
}
