/**
 * Contract: the detail page (/sites/[id]) and the edit page
 * (/sites/[id]/edit) MUST render their preview iframes from the same
 * Instinct-internal source — /sites/[id]/preview — so what the user
 * sees on the left while editing always matches what they see on the
 * right after saving.
 *
 * Before 2026-04-18 the detail iframe pointed at the DEPLOYED Vercel
 * URL while the edit iframe pointed at /sites/[id]/preview; the two
 * sources drifted (deployed bundle vs Instinct's RenderBrief) and the
 * two pages showed visibly different content for the same brief. That
 * was reported twice ("the sites page and prompt editor view of the
 * same site don't match"). This test locks the fix.
 *
 * Regex strategy: we grep the two page files for the literal src prop
 * on PreviewIframe / edit-preview iframe and assert both resolve to
 * the `/sites/{id}/preview` prefix. If a future refactor flips either
 * page back to project.preview_url or a deployed URL, this test fails.
 */

import * as fs from "node:fs";
import * as path from "node:path";

function read(p: string): string {
  return fs.readFileSync(path.resolve(__dirname, "..", "..", "..", p), "utf8");
}

describe("preview-source parity — detail page and edit page match", () => {
  const DETAIL_PAGE = "src/app/(dashboard)/sites/[id]/page.tsx";
  const EDIT_PAGE = "src/app/(dashboard)/sites/[id]/edit/page.tsx";
  const INTERNAL_PREVIEW_PATTERN = /\/sites\/\$\{\s*id\s*\}\/preview/;

  it("detail page PreviewIframe src points at /sites/{id}/preview", () => {
    const src = read(DETAIL_PAGE);
    // Extract the <PreviewIframe ... /> block. Template literals in the
    // src attribute include `${id}` which itself contains `}`, so we
    // match greedily from <PreviewIframe to the closing `/>` and trust
    // that nothing else ends a self-closing JSX element between them.
    const previewIframeMatch = src.match(/<PreviewIframe[\s\S]*?\/>/);
    expect(previewIframeMatch).not.toBeNull();
    const element = previewIframeMatch![0];
    expect(element).toMatch(INTERNAL_PREVIEW_PATTERN);

    // Explicit negative guard: must NOT pass project.preview_url as
    // the iframe src. The "Open ↗" link below still uses preview_url —
    // only the iframe source moved.
    expect(element).not.toMatch(/src=\{project\.preview_url/);
  });

  it("edit page preview iframe src points at /sites/{id}/preview", () => {
    const src = read(EDIT_PAGE);
    // The edit page builds the iframe src via a previewUrl expression
    // that embeds `/sites/${id}/preview`; assert both shapes exist.
    expect(src).toMatch(INTERNAL_PREVIEW_PATTERN);
    // The edit page ALSO appends a `?draft=` query param so the
    // in-memory draft flows through without a save. Lock that too so a
    // future refactor can't silently drop draft passthrough.
    expect(src).toMatch(/\?draft=/);
  });

  it("detail page keeps the deployed preview_url accessible via 'Open ↗' even after iframe flip", () => {
    // Parity guarantee: users can still view the deployed Vercel URL
    // via the Open link / Copy link button — so the source of truth
    // for production is not lost when we switched the iframe source.
    const src = read(DETAIL_PAGE);
    expect(src).toMatch(/href=\{project\.preview_url!?\}/);
    expect(src).toMatch(/copyPreview/);
  });
});
