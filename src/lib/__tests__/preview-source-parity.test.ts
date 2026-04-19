/**
 * Contract: the detail page (/sites/[id]) and the edit page
 * (/sites/[id]/edit) MUST render their preview iframes from the same
 * Instinct-internal source — /sites/[id]/preview — so what the user
 * sees on the left while editing always matches what they see on the
 * right after saving. The preview route itself then decides whether to
 * iframe the DEPLOYED Vercel URL (when preview_url is set and there's
 * no in-memory draft) or fall back to Instinct's internal RenderBrief
 * for drafts / pre-deploy state. Both entry pages stay blind to that
 * choice — they just point at /sites/[id]/preview.
 *
 * History: before 2026-04-18 detail iframed project.preview_url while
 * edit iframed /sites/[id]/preview; the two sources drifted. The
 * 9097a47 fix unified both on /sites/[id]/preview but that route only
 * rendered RenderBrief, which doesn't carry the template's styles or
 * wireframe-sourced content — so the detail page showed an unstyled
 * stub while the deployed URL still had the real site. The follow-up
 * fix (this commit) makes /sites/[id]/preview iframe the deployed URL
 * for saved+deployed briefs, keeping parity AND surfacing the real
 * styled site on both pages.
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
    const previewIframeMatch = src.match(/<PreviewIframe[\s\S]*?\/>/);
    expect(previewIframeMatch).not.toBeNull();
    const element = previewIframeMatch![0];
    expect(element).toMatch(INTERNAL_PREVIEW_PATTERN);

    // Explicit negative guard: the detail iframe must NOT pass
    // project.preview_url directly — the preview route owns that
    // decision now so drift can't creep back in.
    expect(element).not.toMatch(/src=\{project\.preview_url/);
  });

  it("edit page preview iframe src points at /sites/{id}/preview with draft passthrough", () => {
    const src = read(EDIT_PAGE);
    expect(src).toMatch(INTERNAL_PREVIEW_PATTERN);
    expect(src).toMatch(/\?draft=/);
  });

  it("detail page keeps the deployed preview_url accessible via 'Open ↗' + Copy link", () => {
    const src = read(DETAIL_PAGE);
    expect(src).toMatch(/href=\{project\.preview_url!?\}/);
    expect(src).toMatch(/copyPreview/);
  });
});
