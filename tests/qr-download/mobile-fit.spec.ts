/**
 * Real-browser guard: the Show-QR panel must fit within a mobile
 * viewport so the full QR code is visible (no run-off past the right
 * edge). Reproduces the wrapper's inline sizing from the QR row
 * (width:192 capped at max-width:100% of its container) and asserts it
 * never exceeds the viewport at narrow widths. Standalone — no dev
 * server/DB/auth (playwright.qr.config.ts).
 */
import { test, expect, devices } from "@playwright/test";

const QR_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192" width="192" height="192" ' +
  'style="width:100%;height:100%;display:block"><rect width="192" height="192" fill="#fff"/>' +
  '<rect width="56" height="56" fill="#000"/><rect x="136" width="56" height="56" fill="#000"/>' +
  '<rect y="136" width="56" height="56" fill="#000"/></svg>';

// Mirrors the page: full layout nesting + the column-stacked panel +
// the wrapper's INLINE style (the fix). If the inline cap regresses, the
// wrapper's right edge will exceed the viewport and this fails.
const HTML = `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1">
<body style="margin:0;background:#0d0d10">
<main style="padding:16px;overflow-x:hidden;min-width:0">
  <div style="border:1px solid #333;border-radius:8px;padding:20px;background:#1a1a1a">
    <div style="display:grid;gap:1.5rem;max-width:100%;min-width:0;overflow-x:hidden;padding:0 0.75rem">
      <div style="border:1px solid #333;border-radius:8px;padding:0.85rem 1rem">
        <div style="margin-top:10px;padding:12px;border:1px solid #333;border-radius:6px;background:#222;display:flex;flex-direction:column;align-items:flex-start;gap:16px;flex-wrap:wrap;max-width:100%;min-width:0">
          <div data-testid="qr-wrap" style="width:192px;max-width:100%;aspect-ratio:1 / 1;background:#fff;padding:8px;border-radius:4px;box-sizing:border-box;overflow:hidden">${QR_SVG}</div>
          <div style="display:flex;flex-direction:column;gap:8px">
            <div style="display:flex;flex-wrap:wrap;gap:6px">
              <select><option>PNG (transparent)</option></select>
              <select><option>1024 px</option></select>
              <button>Download</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</main></body>`;

for (const deviceName of ["iPhone SE", "iPhone 14"]) {
  test(`Show-QR panel fits within ${deviceName} viewport (full QR visible)`, async ({
    browser,
  }) => {
    const ctx = await browser.newContext({ ...devices[deviceName] });
    const page = await ctx.newPage();
    await page.setContent(HTML, { waitUntil: "load" });
    const vw = page.viewportSize()!.width;

    const m = await page.evaluate(() => {
      const wrap = document.querySelector('[data-testid="qr-wrap"]')!;
      const svg = wrap.querySelector("svg")!;
      return {
        docW: document.documentElement.scrollWidth,
        clientW: document.documentElement.clientWidth,
        wrapRight: wrap.getBoundingClientRect().right,
        svgWidth: svg.getBoundingClientRect().width,
      };
    });

    // No horizontal page overflow.
    expect(m.docW).toBeLessThanOrEqual(m.clientW + 1);
    // QR wrapper does not run off the right edge.
    expect(m.wrapRight).toBeLessThanOrEqual(vw + 1);
    // The QR is actually rendered (full code visible, non-trivial size).
    expect(m.svgWidth).toBeGreaterThan(100);
    await ctx.close();
  });
}

// The actual production bug: on mobile the panel becomes a COLUMN, and the
// wide brand font makes the download controls push the panel wider than the
// viewport. With align-items:center the QR was horizontally centered and ran
// off the right edge. align-items:flex-start keeps the full QR visible from
// the left regardless of how wide the controls are.
const COLUMN_PANEL = (align: "center" | "flex-start") => `<!doctype html>
<meta name="viewport" content="width=device-width, initial-scale=1"><body style="margin:0">
<div style="padding:16px;overflow-x:hidden"><div style="padding:0 12px">
  <div style="display:flex;flex-direction:column;align-items:${align};flex-wrap:wrap;gap:16px;max-width:100%;min-width:0;padding:12px;border:1px solid #333">
    <div data-testid="qr-wrap" style="width:192px;max-width:100%;aspect-ratio:1 / 1;background:#fff;box-sizing:border-box">
      <svg viewBox="0 0 192 192" style="width:100%;height:100%"><rect width="192" height="192" fill="#fff"/></svg>
    </div>
    <div style="width:600px;background:#444;height:30px">wide control</div>
  </div>
</div></div></body>`;

test("column Show-QR panel keeps the QR fully visible even when controls overflow (iPhone 14)", async ({
  browser,
}) => {
  const ctx = await browser.newContext({ ...devices["iPhone 14"] });
  const page = await ctx.newPage();
  const vw = page.viewportSize()!.width;

  // Sanity: the OLD behavior (center) would clip — confirms this test
  // exercises the real failure mode.
  await page.setContent(COLUMN_PANEL("center"), { waitUntil: "load" });
  const centered = await page.evaluate(
    () => document.querySelector('[data-testid="qr-wrap"]')!.getBoundingClientRect().right,
  );
  expect(centered).toBeGreaterThan(vw); // centered QR runs off the edge

  // The fix: flex-start keeps the full QR within the viewport.
  await page.setContent(COLUMN_PANEL("flex-start"), { waitUntil: "load" });
  const r = await page.evaluate(() => {
    const b = document.querySelector('[data-testid="qr-wrap"]')!.getBoundingClientRect();
    return { left: b.left, right: b.right };
  });
  expect(r.left).toBeGreaterThanOrEqual(0);
  expect(r.right).toBeLessThanOrEqual(vw + 1);
  await ctx.close();
});
