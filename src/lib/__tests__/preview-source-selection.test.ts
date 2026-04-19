/**
 * selectPreviewSource — pure decision locked by unit tests so every
 * render branch of /sites/[id]/preview stays deterministic.
 *
 * Truth table (in priority order):
 *   1. draftBrief present               → "draft"           (RenderBrief of in-memory draft)
 *   2. preview_url set + non-empty      → "deployed"        (iframe the Vercel URL)
 *   3. otherwise                        → "fallback_saved"  (RenderBrief of saved brief)
 *
 * Why this matters: the 9097a47 regression (detail page showed the
 * internal RenderBrief stub instead of the deployed site) happened
 * because the saved path had no way to surface the deployed URL. This
 * file encodes the new saved-mode behavior so a future refactor can't
 * silently drop "deployed" and re-introduce the stub.
 *
 * Analytics contract (enforced by consumer tests): the `source` value
 * flows into the site.preview_viewed event so the learning loop can
 * track deployed vs internal renders. Changing the enum without
 * updating the analytics consumer breaks that signal.
 */

import { selectPreviewSource } from "@/app/sites/[id]/preview/page";
import type { SiteBrief } from "@/lib/sites-schema";

const SAVED: SiteBrief = {
  client: "acme",
  product: { name: "Acme" },
  pages: [{ route: "/", title: "Home", sections: [] }],
};

const DRAFT: SiteBrief = {
  client: "acme",
  product: { name: "Acme — draft" },
  pages: [{ route: "/", title: "Home", sections: [] }],
};

describe("selectPreviewSource — priority and outputs", () => {
  it("draft wins over deployed when both are available", () => {
    const out = selectPreviewSource({
      draftBrief: DRAFT,
      savedBrief: SAVED,
      previewUrl: "https://wolfpack-example.vercel.app",
    });
    expect(out).toEqual({ source: "draft", brief: DRAFT, deployedUrl: null });
  });

  it("no draft + preview_url → deployed (iframe deployed URL, no brief)", () => {
    const out = selectPreviewSource({
      draftBrief: null,
      savedBrief: SAVED,
      previewUrl: "https://wolfpack-example.vercel.app",
    });
    expect(out).toEqual({
      source: "deployed",
      brief: null,
      deployedUrl: "https://wolfpack-example.vercel.app",
    });
  });

  it("no draft + null preview_url → fallback_saved (RenderBrief of saved)", () => {
    const out = selectPreviewSource({
      draftBrief: null,
      savedBrief: SAVED,
      previewUrl: null,
    });
    expect(out).toEqual({ source: "fallback_saved", brief: SAVED, deployedUrl: null });
  });

  it("empty-string preview_url is treated as unset (fallback, not deployed)", () => {
    const out = selectPreviewSource({
      draftBrief: null,
      savedBrief: SAVED,
      previewUrl: "",
    });
    expect(out).toEqual({ source: "fallback_saved", brief: SAVED, deployedUrl: null });
  });

  it("no draft + null preview_url + null savedBrief → fallback_saved with null brief", () => {
    // This is the pre-first-save state — the page surfaces "no brief yet"
    // via its existing empty-state branch. The selector's job is just
    // to report fallback_saved + null so the consumer can render empty.
    const out = selectPreviewSource({
      draftBrief: null,
      savedBrief: null,
      previewUrl: null,
    });
    expect(out).toEqual({ source: "fallback_saved", brief: null, deployedUrl: null });
  });

  it("draft present but preview_url null → still draft (draft never silently downgrades)", () => {
    const out = selectPreviewSource({
      draftBrief: DRAFT,
      savedBrief: null,
      previewUrl: null,
    });
    expect(out.source).toBe("draft");
    expect(out.brief).toBe(DRAFT);
  });
});
