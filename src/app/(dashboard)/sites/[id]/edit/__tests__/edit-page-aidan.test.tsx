/**
 * @jest-environment jsdom
 */

/**
 * Edit-page pair test for migration 081_adopt_wolfpack_aidan_mulready.
 *
 * Asserts the end-to-end behaviour a designer sees when they click into
 * /sites/{adopted_id}/edit:
 *
 *   1. The editor's URL selector (`selectEditorPreviewUrl`) produces a
 *      bare `/sites/{id}/preview?t=...` URL when there are no pending
 *      edits and a Vercel preview_url exists — the editor-vs-live parity
 *      contract (Agent C, 2026-04-23).
 *   2. The preview page's decision (`selectPreviewSource`) then picks
 *      `source=deployed` and routes the iframe at the Aidan Vercel URL.
 *   3. The hero heading from the adopted brief — "AIDAN MULREADY" —
 *      renders through <RenderBrief /> so the editor's fallback render
 *      path (no deployed URL) is proven to paint the brief correctly.
 *
 * Why not mount the full <SiteEditPage /> here: the edit + preview pages
 * both call `use(params: Promise<{ id }>)`, which suspends in jsdom and
 * never resolves under React Testing Library's scheduler (same limitation
 * documented at the top of render-brief.test.tsx + preview-url-parity.
 * test.ts). Covering the composite flow via the pure helpers + the
 * renderer keeps the test deterministic and offline; the full round-trip
 * has its own Playwright E2E in tests/e2e/sites-edit-flow.spec.ts.
 *
 * Nick's 2026-04-24 ask on this safety net: "we must know if anything
 * breaks because clients will experience the bug." Every assertion here
 * targets a specific visible element / concrete return value.
 */

import "@testing-library/jest-dom";
import { render, screen, within } from "@testing-library/react";

import { selectEditorPreviewUrl } from "@/app/(dashboard)/sites/[id]/edit/page";
import { selectPreviewSource } from "@/app/sites/[id]/preview/page";
import { RenderBrief } from "@/components/sites/render-brief";
import type { SiteBrief } from "@/lib/sites";

const ADOPTED_ID = "site_aidan_mulready_cftr";
const AIDAN_PREVIEW_URL = "https://wolfpack-aidan-mulready.vercel.app";

// Subset of the full brief inlined in migration 081 — just enough to
// exercise the renderer. If migration 081's inlined JSONB drifts from
// this fixture the sites-page-aidan + migration-081-adoption tests
// will fail separately; keeping this fixture minimal avoids duplicating
// the whole brief here.
const AIDAN_BRIEF: SiteBrief = {
  client: "aidan-mulready",
  product: {
    name: "Cleared for Takeoff Racing",
    tagline: "Irish racing. Nürburgring stage. Season 2025.",
  },
  pages: [
    {
      route: "/",
      title: "Aidan Mulready — CFTR",
      sections: [
        {
          type: "hero",
          heading: "AIDAN MULREADY",
          body: "Ford Z-Tech Champion · NLS Nürburgring · Nürburgring 24 Hours · Breakell Racing BMW M235i · Car #667",
          cta: { label: "Partner With Us", href: "/contact" },
        },
        {
          type: "banner",
          heading: "CHAMPION",
          body: "Ford Z-Tech Series · First Year in a Race Car · Ireland",
        },
      ],
    },
  ],
};

describe("edit-page adoption — wolfpack-aidan-mulready", () => {
  describe("editor URL selection", () => {
    it("no pending edits + Aidan preview_url → bare preview URL (deployed branch)", () => {
      const url = selectEditorPreviewUrl({
        siteId: ADOPTED_ID,
        dirty: false,
        previewUrl: AIDAN_PREVIEW_URL,
        draft: AIDAN_BRIEF,
        iframeNonce: 0,
      });
      expect(url).toBe(`/sites/${ADOPTED_ID}/preview?t=0`);
      // Must NOT route through the synthetic renderer when we have a
      // deployed URL available — that's the drift bug.
      expect(url).not.toContain("draft=");
    });

    it("pending edits → falls back to synthetic renderer with ?draft= envelope", () => {
      const url = selectEditorPreviewUrl({
        siteId: ADOPTED_ID,
        dirty: true,
        previewUrl: AIDAN_PREVIEW_URL,
        draft: AIDAN_BRIEF,
        iframeNonce: 4,
      });
      expect(url).toContain(`/sites/${ADOPTED_ID}/preview?draft=`);
      expect(url).toContain("&t=4");
    });
  });

  describe("preview page decision", () => {
    it("no draft + Aidan preview_url → deployed source pointing at the Vercel URL", () => {
      const decision = selectPreviewSource({
        draftBrief: null,
        savedBrief: AIDAN_BRIEF,
        previewUrl: AIDAN_PREVIEW_URL,
      });
      expect(decision.source).toBe("deployed");
      expect(decision.deployedUrl).toBe(AIDAN_PREVIEW_URL);
    });

    it("exact host equality — not a broader contains match", () => {
      const decision = selectPreviewSource({
        draftBrief: null,
        savedBrief: AIDAN_BRIEF,
        previewUrl: AIDAN_PREVIEW_URL,
      });
      expect(decision.deployedUrl).not.toBeNull();
      const host = new URL(decision.deployedUrl as string).host;
      expect(host).toBe("wolfpack-aidan-mulready.vercel.app");
    });

    it("draft present (dirty editor) → routes to 'draft' renderer, not the Vercel iframe", () => {
      const decision = selectPreviewSource({
        draftBrief: AIDAN_BRIEF,
        savedBrief: AIDAN_BRIEF,
        previewUrl: AIDAN_PREVIEW_URL,
      });
      expect(decision.source).toBe("draft");
      expect(decision.deployedUrl).toBeNull();
    });

    it("preview_url missing → fallback_saved renders the brief in place", () => {
      const decision = selectPreviewSource({
        draftBrief: null,
        savedBrief: AIDAN_BRIEF,
        previewUrl: null,
      });
      expect(decision.source).toBe("fallback_saved");
      expect(decision.brief).toBe(AIDAN_BRIEF);
      expect(decision.deployedUrl).toBeNull();
    });
  });

  describe("brief renderer — hero section paints AIDAN MULREADY", () => {
    it("renders the hero heading verbatim so clients see the right name", () => {
      render(<RenderBrief brief={AIDAN_BRIEF} />);
      // Hero heading lives in an <h1>. Role-based query so CSS changes
      // (font size, color) don't break the test.
      const heading = screen.getByRole("heading", {
        level: 1,
        name: "AIDAN MULREADY",
      });
      expect(heading).toBeInTheDocument();
    });

    it("renders the hero body line with Breakell Racing + car number", () => {
      render(<RenderBrief brief={AIDAN_BRIEF} />);
      // Partial match — the body is a long line; key identifiers only.
      expect(screen.getByText(/Breakell Racing/)).toBeInTheDocument();
      expect(screen.getByText(/Car #667/)).toBeInTheDocument();
    });

    it("renders the hero CTA as an anchor with the right href + label", () => {
      render(<RenderBrief brief={AIDAN_BRIEF} />);
      const cta = screen.getByRole("link", { name: /Partner With Us/i });
      expect(cta).toHaveAttribute("href", "/contact");
    });

    it("renders the banner section's CHAMPION heading in addition to the hero", () => {
      const { container } = render(<RenderBrief brief={AIDAN_BRIEF} />);
      // Scope to the first page / second section.
      expect(within(container).getByText("CHAMPION")).toBeInTheDocument();
    });
  });

  describe("composite editor → preview round-trip", () => {
    it("designer opens /sites/{adopted}/edit with no edits and the live Vercel URL loads", () => {
      // Step 1: editor builds bare preview URL.
      const editorUrl = selectEditorPreviewUrl({
        siteId: ADOPTED_ID,
        dirty: false,
        previewUrl: AIDAN_PREVIEW_URL,
        draft: AIDAN_BRIEF,
        iframeNonce: 42,
      });
      expect(editorUrl).not.toMatch(/draft=/);

      // Step 2: preview page loads and — having no ?draft — picks the
      // deployed Vercel URL.
      const decision = selectPreviewSource({
        draftBrief: null,
        savedBrief: AIDAN_BRIEF,
        previewUrl: AIDAN_PREVIEW_URL,
      });
      expect(decision.source).toBe("deployed");
      // This is the string that ends up as <iframe src=...> inside the
      // preview page's "deployed" render path (see preview/page.tsx
      // line ~260, <iframe data-testid="preview-root" src={state.deployedUrl}>).
      expect(decision.deployedUrl).toContain("wolfpack-aidan-mulready.vercel.app");
    });

    it("designer types an edit → iframe drops to synthetic renderer, no live URL", () => {
      const editorUrl = selectEditorPreviewUrl({
        siteId: ADOPTED_ID,
        dirty: true,
        previewUrl: AIDAN_PREVIEW_URL,
        draft: {
          ...AIDAN_BRIEF,
          pages: [
            {
              route: "/",
              sections: [
                { type: "hero", heading: "CHANGED" },
              ],
            },
          ],
        },
        iframeNonce: 9,
      });
      expect(editorUrl).toMatch(/draft=/);

      const decision = selectPreviewSource({
        draftBrief: AIDAN_BRIEF,
        savedBrief: AIDAN_BRIEF,
        previewUrl: AIDAN_PREVIEW_URL,
      });
      // Even though Aidan has a deployed URL, ANY draft forces the
      // synthetic renderer so unsaved text appears in the iframe.
      expect(decision.source).toBe("draft");
      expect(decision.deployedUrl).toBeNull();
    });
  });
});
