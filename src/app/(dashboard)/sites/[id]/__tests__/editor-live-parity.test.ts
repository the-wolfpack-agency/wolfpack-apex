/**
 * @jest-environment jsdom
 *
 * Editor-vs-live parity — end-to-end decision contract.
 *
 * Asserts the composite behaviour across the editor URL selector and the
 * preview page's `selectPreviewSource`: for a non-dirty draft with a
 * deployed preview_url, both surfaces settle on the same "deployed"
 * render path, which means the iframe in /sites/[id]/edit shows exactly
 * the same bytes as the client-facing Vercel URL — the exact pixel
 * parity the user asked for on 2026-04-23.
 */

import { selectEditorPreviewUrl } from "@/app/(dashboard)/sites/[id]/edit/page";
import { selectPreviewSource } from "@/app/sites/[id]/preview/page";

const SITE_ID = "site_a3106cfe-ee77-4641-aec5-ce9f1d7a9ce1";
const SAVED_BRIEF = {
  client: "fixture",
  product: { name: "Fixture" },
  pages: [{ route: "/", sections: [{ type: "hero", heading: "Welcome" }] }],
};

test("editor (no dirty) + preview page together route to the deployed URL", () => {
  // Step 1 — editor builds a bare preview URL (no ?draft).
  const editorUrl = selectEditorPreviewUrl({
    siteId: SITE_ID,
    dirty: false,
    previewUrl: "https://wolfpack-fixture.vercel.app",
    draft: SAVED_BRIEF,
    iframeNonce: 1,
  });
  expect(editorUrl).not.toMatch(/draft=/);

  // Step 2 — preview page receives no draft → picks "deployed".
  const decision = selectPreviewSource({
    draftBrief: null,
    savedBrief: SAVED_BRIEF as any,
    previewUrl: "https://wolfpack-fixture.vercel.app",
  });
  expect(decision.source).toBe("deployed");
  expect(decision.deployedUrl).toBe("https://wolfpack-fixture.vercel.app");
});

test("editor (dirty) triggers the preview page into the 'draft' synthetic-render branch", () => {
  const editorUrl = selectEditorPreviewUrl({
    siteId: SITE_ID,
    dirty: true,
    previewUrl: "https://wolfpack-fixture.vercel.app",
    draft: { ...SAVED_BRIEFHelper(), pages: [{ route: "/", sections: [{ type: "hero", heading: "Different" }] }] },
    iframeNonce: 2,
  });
  expect(editorUrl).toMatch(/draft=/);

  // Verify preview.tsx, given a non-null draftBrief, picks "draft" even
  // with a deployed URL present.
  const decision = selectPreviewSource({
    draftBrief: SAVED_BRIEF as any,
    savedBrief: SAVED_BRIEF as any,
    previewUrl: "https://wolfpack-fixture.vercel.app",
  });
  expect(decision.source).toBe("draft");
  expect(decision.deployedUrl).toBeNull();
});

function SAVED_BRIEFHelper() {
  return JSON.parse(JSON.stringify(SAVED_BRIEF));
}
