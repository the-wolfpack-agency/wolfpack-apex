/**
 * @jest-environment jsdom
 *
 * Editor-vs-live preview parity contract (Agent C, 2026-04-23).
 *
 * Root cause of the "editor displays differently than URL" bug:
 * /sites/[id]/edit was always computing a `?draft=<base64>` URL and
 * passing it to the preview iframe, which forced the internal
 * RenderBrief path inside /sites/[id]/preview — that path can't know
 * about template-side assets (images / copy written into
 * wolfpack-site-template that don't live in SiteBrief), so designers
 * saw drift between what the editor showed and what the deployed
 * URL rendered.
 *
 * Fix: when `dirty=false` AND a `preview_url` exists, compute a bare
 * `/sites/[id]/preview?t=...` URL so preview.tsx's `selectPreviewSource`
 * falls through to the deployed-iframe branch. This suite pins that
 * behavior so the bug cannot silently regress.
 */

import { selectEditorPreviewUrl } from "@/app/(dashboard)/sites/[id]/edit/page";

const SITE_ID = "site_a3106cfe-ee77-4641-aec5-ce9f1d7a9ce1";
const BRIEF = { client: "c", product: { name: "p" }, pages: [] };

test("no dirty changes + deployed preview_url → bare preview URL (deployed branch)", () => {
  const url = selectEditorPreviewUrl({
    siteId: SITE_ID,
    dirty: false,
    previewUrl: "https://wolfpack-c.vercel.app",
    draft: BRIEF,
    iframeNonce: 7,
  });
  expect(url).toBe(`/sites/${SITE_ID}/preview?t=7`);
  expect(url).not.toContain("draft=");
});

test("dirty changes → preview URL carries ?draft= (synthetic renderer)", () => {
  const url = selectEditorPreviewUrl({
    siteId: SITE_ID,
    dirty: true,
    previewUrl: "https://wolfpack-c.vercel.app",
    draft: BRIEF,
    iframeNonce: 3,
  });
  expect(url).toContain(`/sites/${SITE_ID}/preview?draft=`);
  expect(url).toContain("&t=3");
});

test("no deployed preview_url + no dirty → still uses ?draft= so something renders", () => {
  const url = selectEditorPreviewUrl({
    siteId: SITE_ID,
    dirty: false,
    previewUrl: null,
    draft: BRIEF,
    iframeNonce: 1,
  });
  expect(url).toContain("draft=");
});

test("enormous payload falls back to bare URL instead of 414-sized querystring", () => {
  const huge = { client: "c", product: { name: "p" }, pages: [], blob: "x".repeat(400_000) };
  const url = selectEditorPreviewUrl({
    siteId: SITE_ID,
    dirty: true,
    previewUrl: null,
    draft: huge,
    iframeNonce: 9,
  });
  expect(url).toBe(`/sites/${SITE_ID}/preview?t=9`);
});
